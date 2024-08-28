import axios from "axios";
import { CoralogixQueryResult, CoralogixRegionKey } from "../../../types";
import { CoralogixIntegration, IIntegration } from "@merlinn/db";
import {
  Timeframe,
  getTimestamp,
  timeframe2values,
} from "../../../utils/dates";
import { CoralogixClient } from "../../../clients/coralogix";
import { extractLogStructureKeysPrompt } from "../../../agent/prompts";
import { JsonOutputParser } from "langchain/schema/output_parser";
import { chatModel } from "../../../agent/model";

function getKeys(obj: Record<string, unknown>, path: string[] = []): string[] {
  let result: string[] = [];

  for (const key in obj) {
    const currentPath = [...path, key];

    if (typeof obj[key] === "object" && obj[key] !== null) {
      result = result.concat(
        getKeys(obj[key] as Record<string, unknown>, currentPath),
      );
    } else {
      result.push(currentPath.join("."));
    }
  }

  return result;
}

export const getCommonLogFields = async (
  apiKey: string,
  region: CoralogixRegionKey,
): Promise<string[]> => {
  const startDate = String(getTimestamp({ amount: 7, scale: "days" }));
  const endDate = String(getTimestamp({}));

  const client = new CoralogixClient({ logsKey: apiKey }, region);
  const { result } = await client.getLogs({
    query: "source logs | limit 1000",
    startDate,
    endDate,
  });
  const logs = result.results;
  const fields = logs.reduce((total, current) => {
    const data = JSON.parse(current.userData);
    const keys = getKeys(data);
    keys.forEach((key) => total.add(key));
    return total;
  }, new Set());

  return Array.from(fields) as string[];
};

export const getCommonLogValues = async (
  field: string,
  apiKey: string,
  region: CoralogixRegionKey,
) => {
  const startDate = String(getTimestamp({ amount: 7, scale: "days" }));
  const endDate = String(getTimestamp({}));

  const client = new CoralogixClient({ logsKey: apiKey }, region);
  const query = `source logs | distinct ${field} | limit 100`;
  const { result } = await client.getLogs({
    query,
    startDate,
    endDate,
  });

  const values = result.results.map(
    (obj) => Object.values(JSON.parse(obj.userData))[0],
  );
  return values;
};

export const getLogSample = async (
  logsKey: string,
  region: "EU1" | "AP1" | "US1" | "EU2" | "AP2" | "US2",
  amount: number = 5,
) => {
  const startDate = getTimestamp({ amount: 7, scale: "days" });
  const endDate = new Date().toISOString();

  const client = new CoralogixClient({ logsKey }, region);
  const query = `source logs | limit ${amount}`;
  const result = await client.getLogs({
    syntax: "QUERY_SYNTAX_DATAPRIME",
    query,
    startDate,
    endDate,
  });
  if (!result.result?.results) {
    return [];
  }

  const rows = result.result?.results.map((o) => JSON.parse(o.userData));
  return rows;
};

export const getPrettyLogSample = async (
  logsKey: string,
  region: "EU1" | "AP1" | "US1" | "EU2" | "AP2" | "US2",
  amount: number = 5,
) => {
  const logSample = await getLogSample(logsKey, region, amount);
  const formattedLogSample = logSample
    .map((log) =>
      Object.entries(log)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
    )
    .join("\n\n--------------------------------------\n\n");

  return formattedLogSample;
};

interface LogCluster extends Record<string, unknown> {
  Level: string;
  EventId: string;
  EventTemplate: string;
  Occurrences: number;
  Percentage: number;
}

interface ParseLogsResponse {
  clusters: LogCluster[];
}

async function extractLogStructuralKeys(logRecords: string[]) {
  const queriesPrompt = await extractLogStructureKeysPrompt.format({
    logRecords,
  });
  const parser = new JsonOutputParser();
  try {
    const { content } = await chatModel.invoke(queriesPrompt);
    const { severityKey, messageKey } = await parser.parse(content as string);
    if (!severityKey || !messageKey) {
      throw new Error("Failed to extract log structure keys");
    }
    return { severityKey, messageKey };
  } catch (error) {
    console.error("Error generating queries", error);
    throw error;
  }
}

export async function getLogClusters({
  query = "",
  integration,
  timeframe,
}: {
  query?: string;
  integration: IIntegration;
  timeframe: Timeframe;
}): Promise<{
  clusters: LogCluster[];
  parsedLogs: CoralogixQueryResult;
}> {
  switch (integration.vendor.name) {
    case "Coralogix": {
      const { logsKey } = (integration as CoralogixIntegration).credentials;
      const { region } = (integration as CoralogixIntegration).metadata;

      const [amount, scale] = timeframe2values[timeframe];
      const startDate = getTimestamp({ amount, scale });
      const endDate = new Date().toISOString();

      const client = new CoralogixClient({ logsKey }, region);
      const logs = await client.getRawLogs({
        syntax: "QUERY_SYNTAX_DATAPRIME",
        query,
        startDate,
        endDate,
      });

      const parsedLogs = client.parseResult(logs);
      const sample = (await getLogSample(logsKey, region, 2)).map((r) =>
        JSON.stringify(r),
      );
      try {
        const { messageKey, severityKey } =
          await extractLogStructuralKeys(sample);

        const logParserUrl = process.env.LOG_PARSER_URL as string;
        const {
          data: { clusters },
        } = await axios.post<ParseLogsResponse>(
          `${logParserUrl}/parse/coralogix`,
          { logs, severityKey, messageKey },
        );

        return { clusters, parsedLogs };
      } catch (error) {
        console.error(
          `Error clustering logs for query ${query}. Error: ${error}`,
        );
        throw error;
      }
    }
    default: {
      throw new Error("Unknown log vendor");
    }
  }
}

export async function getPrettyLogAnalysis({
  query = "",
  integration,
  timeframe,
}: {
  query?: string;
  integration: IIntegration;
  timeframe: Timeframe;
}): Promise<{
  analysis: string;
  parsedLogs: CoralogixQueryResult;
}> {
  const { clusters, parsedLogs } = await getLogClusters({
    query,
    integration,
    timeframe,
  });
  const formattedClusters = clusters
    .map((cluster, index) => {
      const {
        Level,
        EventTemplate,
        Occurrences,
        Percentage,
        ...additionalInfo
      } = cluster;
      return `
      Cluster: ${index + 1}
      Log level: ${Level}
      Log template: ${EventTemplate}
      Occurrences: ${Occurrences}
      Percentage: ${Percentage}
      Addtitonal Cluster Info: ${JSON.stringify(additionalInfo, null, 2)}
    `;
    })
    .join("\n----------------\n");

  // Branch 3 - combine both branches
  const formattedAnalysis = `
    Log aggregation/cluster analysis:
    ${formattedClusters}
  `;

  return { analysis: formattedAnalysis, parsedLogs };
}

// (async () => {
//   await connectToDB(process.env.MONGO_URI as string);

//   let integrations = (await integrationModel
//     .get()
//     .populate("vendor")) as IIntegration[];
//   integrations = await secretManager.populateCredentials(integrations);

//   const logVendor = integrations.find(
//     (integration) => integration.vendor.name === "Coralogix",
//   );

//   if (!logVendor) {
//     throw new Error("No Coralogix integration found");
//   }

//   const clusters = await getLogClusters(logVendor);

//   console.log(clusters);
// })();

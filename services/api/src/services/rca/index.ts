import { parseAlert } from "../alerts";
import type { EventSource } from "../../types/internal";
import {
  generateQueriesPrompt,
  investigationLeanTemplate,
  // investigationTemplate,
  verifyDocumentPrompt,
} from "../../agent/prompts";
import { chatModel } from "../../agent/model";
import { getVectorStore, nodesToText } from "../../agent/rag";
import type { Document } from "../../agent/rag/types";
import { buildPrompt } from "../alerts/utils";
import {
  VendorName,
  indexModel,
  integrationModel,
  organizationModel,
} from "@merlinn/db";
import type { IIndex, IIntegration } from "@merlinn/db";
import { JsonOutputParser } from "langchain/schema/output_parser";
import { secretManager } from "../../common/secrets";
// import { createToolsForVendor } from "../../agent/tools";
// import { createAgent } from "../../agent/agent";
import { RunContext } from "../../agent/types";
import { ToolLoader } from "../../agent/tools/types";
import { toolLoaders as coralogixToolLoaders } from "../../agent/tools/coralogix";
import {
  getPrettyLogAnalysis,
  limitLogs,
} from "../../agent/tools/coralogix/utils";
import { Timeframe } from "../../utils/dates";

async function generateQueries(
  incidentText: string,
  nQueries: number = 3,
): Promise<string[]> {
  const queriesPrompt = await generateQueriesPrompt.format({
    incident: incidentText,
    nQueries,
  });
  const parser = new JsonOutputParser();
  try {
    const { content } = await chatModel.invoke(queriesPrompt);
    const { queries } = await parser.parse(content as string);
    if (!queries || queries.length === 0) {
      throw new Error("No queries generated");
    }
    return queries;
  } catch (error) {
    console.error("Error generating queries", error);
    throw error;
  }
}

async function verifyDocument(
  incidentText: string,
  document: string,
): Promise<boolean> {
  const queriesPrompt = await verifyDocumentPrompt.format({
    incident: incidentText,
    document,
  });
  try {
    const { content } = await chatModel.invoke(queriesPrompt);
    const answer = (content as string).toLowerCase();

    // Since we ask the LLM to just generate true or false, we can just parse the response
    return JSON.parse(answer);
  } catch (error) {
    console.error("Error parsing the response", error);
    throw error;
  }
}

// This step is used as a reflectio step, to remove noise
async function filterDocuments(
  incidentText: string,
  documents: Document[],
): Promise<Document[]> {
  const verifications = await Promise.all(
    documents.map((doc) => verifyDocument(incidentText, doc.text)),
  );
  return documents.filter((_, index) => verifications[index]);
}

async function runQueries(
  index: IIndex,
  queries: string[],
): Promise<Document[]> {
  const vectorStore = getVectorStore(index.name, index.type);

  const documents = (
    await Promise.all(
      queries.map(async (query) => vectorStore.query({ query, topK: 3 })),
    )
  ).reduce((acc, val) => acc.concat(val), []);

  return documents;
}

async function summarize(
  incidentText: string,
  contextText: string,
  additionalInfoText?: string,
): Promise<string> {
  const investigationPrompt = await investigationLeanTemplate.format({
    incident: incidentText,
    context: contextText,
    additionalInfo: additionalInfoText || "no additional information",
  });
  const { content } = await chatModel.invoke(investigationPrompt);
  return content as string;
}

async function analyzeLogs(
  incidentText: string,
  integrations: IIntegration[],
  context: RunContext,
  timeframe: Timeframe = Timeframe.Last24Hours,
): Promise<string | undefined> {
  // TODO: extract this array to a constant maybe or introduce a "type" field
  // to the integrations
  // TODO: in the future, we need to add more vendors to here to support more
  // log vendors
  const logVendorToolLoaders: {
    [key in VendorName]?: ToolLoader<IIntegration>[];
  } = {
    [VendorName.Coralogix]: coralogixToolLoaders as ToolLoader<IIntegration>[],
  };

  const logIntegration = integrations.find(
    (integration) => logVendorToolLoaders[integration.vendor.name],
  );
  if (!logIntegration) {
    return;
  }

  const { analysis, parsedLogs } = await getPrettyLogAnalysis({
    integration: logIntegration,
    timeframe,
  });

  if (!analysis) {
    return `
    Could not do log aggregation. Here are the raw logs instead:
    ${limitLogs(JSON.stringify(parsedLogs))}
    `;
  }
  return analysis;
}

export async function runRCA(
  eventId: string,
  eventSource: EventSource,
  organizationId: string,
) {
  const organization = await organizationModel.getOneById(organizationId);
  if (!organization) {
    throw new Error("Organization not found");
  }

  const index = await indexModel.getOne({
    organization: organizationId,
  });
  if (!index) {
    throw new Error("Knowledge base is not set up. Analysis cannot be done.");
  }

  const integrations = (await integrationModel
    .get({
      organization: organizationId,
    })
    .populate("vendor")) as IIntegration[];
  if (!integrations || integrations.length === 0) {
    throw new Error("No integrations found");
  }

  const populatedIntegrations =
    await secretManager.populateCredentials(integrations);

  const context: RunContext = {
    organizationName: organization.name,
    organizationId: organizationId,
    env: process.env.NODE_ENV as string,
    eventId,
    context: `trigger-${eventSource}`,
  };

  const event = await parseAlert(eventId, eventSource, organizationId);
  const incidentText = buildPrompt(event);

  // Phase 1 - Information retrieval phase from Vector DB
  const queries = await generateQueries(incidentText);
  const documents = await runQueries(index, queries);
  const filteredDocuments = await filterDocuments(incidentText, documents);

  const topDocuments = filteredDocuments
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const contextText = nodesToText(topDocuments);

  // Phase 2 - Fetch information from logs
  const logsText = await analyzeLogs(
    incidentText,
    populatedIntegrations,
    context,
  );

  // Phase 3 - Summarization phase
  const analysis = await summarize(incidentText, contextText, logsText);
  return analysis;
}

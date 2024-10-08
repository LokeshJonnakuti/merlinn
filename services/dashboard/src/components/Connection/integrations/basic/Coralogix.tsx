/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback } from "react";
import { API_SERVER_URL } from "../../../../constants";
import { ConnectionProps, ConnectionName } from "../../../../types/Connections";
import { ConnectionWrapper } from "../../styles";
import { FieldConfiguration, IntegrationPayload } from "../../types";
import { IntegrationField } from "../../components/IntegrationField";

const fieldsConfigurations: FieldConfiguration[] = [
  {
    key: "logsKey",
    label: "Logs Query API Key",
    type: "credentials",
    input: { type: "secret" },
  },
  {
    key: "artKey",
    label: "Alerts, Rules and Tags API Key",
    type: "credentials",
    input: { type: "secret" },
  },
  {
    key: "auditKey",
    label: "Audit API Key",
    type: "credentials",
    input: { type: "secret" },
  },
  {
    key: "region",
    label: "Region",
    type: "metadata",
    input: {
      type: "select",
      options: ["EU1", "AP1", "US1", "EU2", "AP2", "US2"],
    },
  },
  {
    key: "domainURL",
    label:
      "Domain Endpoint (for example: https://example.app.eu2.coralogix.com)",
    type: "metadata",
  },
];

export const ConnectCoralogixIntegration = ({
  orgId,
  formData,
  setFormData,
  setRequestData,
  data,
}: ConnectionProps) => {
  const updateState = useCallback(
    async ({ key, value, type }: any) => {
      setRequestData((prev: any) => {
        const body: IntegrationPayload = {
          vendor: ConnectionName.Coralogix,
          organization: orgId,
          metadata: { ...(prev?.body?.metadata || {}) },
          credentials: { ...(prev?.body?.credentials || {}) },
        };

        body[type as keyof IntegrationPayload][key] = value;

        return {
          url: `${API_SERVER_URL}/integrations`,
          body,
        };
      });
    },
    [orgId, setRequestData],
  );

  // https://coralogix.com/docs/coralogix-endpoints/#management
  return (
    <ConnectionWrapper>
      {data ? (
        "Provided information:"
      ) : (
        <>
          <span>
            Please provide the following information. To generate API keys, go
            to Data Flow, API Keys. Domain URL is located at Settings,
            Preferences:
          </span>
        </>
      )}
      {fieldsConfigurations.map((config) => {
        const { key, type } = config;
        const currentValue = data?.[type]?.[key] || formData[key];
        const handleChange = (value: string) => {
          updateState({ key, value, type });
          setFormData((prev: any) => ({
            ...prev,
            [key]: value,
          }));
        };
        return (
          <IntegrationField
            key={config.key}
            config={config}
            value={currentValue}
            onChange={handleChange}
          />
        );
      })}
      {!data && (
        <span style={{ marginTop: "40px", fontSize: "0.8em" }}>
          When you finish click the "Connect" button
        </span>
      )}
    </ConnectionWrapper>
  );
};

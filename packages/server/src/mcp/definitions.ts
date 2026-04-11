/**
 * Pre-installed MCP server definitions.
 * Each entry describes one or more MCP servers launched via stdio under a single provider.
 */

/** A single MCP server that can be launched via npx. */
export interface McpServerEntry {
  /** npm package to run via npx, e.g. "@newrelic/mcp-server-newrelic" */
  package: string;
  /** Extra CLI args after the package name */
  args?: string[];
  /** Maps provider config keys to env var names for the MCP process */
  envMapping: Record<string, string>;
  /** Env var names to forward from parent process if present */
  passthroughEnv?: string[];
}

/** A provider-level definition containing one or more MCP servers. */
export interface McpServerDefinition {
  /** Human-readable name shown in logs */
  label: string;
  /** Domain expertise hint appended to auto-generated system prompt */
  systemPromptHint?: string;
  /** Individual MCP servers to launch for this provider */
  servers: McpServerEntry[];
}

/** Registry of known MCP server definitions, keyed by provider type. */
export const mcpDefinitions = new Map<string, McpServerDefinition>([
  [
    "newrelic",
    {
      label: "New Relic MCP",
      systemPromptHint:
        "You are a New Relic observability expert. Use the available MCP tools to query New Relic data — errors, transactions, logs, NRQL queries, entity lookups, and more. Focus on concrete findings with specific values (counts, timestamps, service names, error messages).",
      servers: [
        {
          package: "@newrelic/mcp-server-newrelic",
          envMapping: {
            apiKey: "NEW_RELIC_API_KEY",
            accountId: "NEW_RELIC_ACCOUNT_ID",
            region: "NEW_RELIC_REGION",
          },
        },
      ],
    },
  ],
  [
    "gcp",
    {
      label: "Google Cloud",
      systemPromptHint:
        "You are a Google Cloud observability expert. Use the available MCP tools to query Cloud Logging, Cloud Monitoring, Cloud Trace, and Error Reporting. Focus on concrete findings with specific values (error messages, counts, timestamps, service names, metric values).",
      servers: [
        {
          package: "@google-cloud/observability-mcp",
          envMapping: {
            projectId: "GOOGLE_CLOUD_PROJECT",
          },
          passthroughEnv: [
            "GOOGLE_APPLICATION_CREDENTIALS",
            "CLOUDSDK_CONFIG",
            "GOOGLE_CLOUD_QUOTA_PROJECT",
          ],
        },
      ],
    },
  ],
]);

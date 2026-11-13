/** An MCP server launched via npx over stdio. */
export interface McpServerEntry {
  /** npm package to run via npx, e.g. "@google-cloud/observability-mcp" */
  package: string;
  /** Exact npm version to pin; avoids floating to `latest` on every spawn. */
  version: string;
  /** Maps provider config keys to env var names for the MCP process */
  envMapping: Record<string, string>;
  /** Env var names to forward from parent process if present */
  passthroughEnv?: string[];
}

export const GCP_MCP_SERVER: McpServerEntry = {
  package: "@google-cloud/observability-mcp",
  version: "0.2.3",
  envMapping: {
    projectId: "GOOGLE_CLOUD_PROJECT",
  },
  passthroughEnv: [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CONFIG",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
  ],
};

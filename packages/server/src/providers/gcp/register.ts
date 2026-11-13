import type { ProviderRegistry } from "../registry.js";
import { GcpProvider } from "./gcp.provider.js";
import { GCP_MCP_SERVER } from "../../mcp/definitions.js";

/** GCP runs its MCP server as a stdio subprocess, so only the Node entry registers it. */
export function registerGcpProvider(providers: ProviderRegistry): void {
  providers.registerFactory(
    "gcp",
    (cfg) => new GcpProvider(GCP_MCP_SERVER, cfg),
    {
      label: "Google Cloud",
      configFields: [],
    },
  );
}

import type { ProviderRegistry } from "../registry.js";
import { GcpProvider } from "./gcp.provider.js";
import { mcpDefinitions } from "../../mcp/definitions.js";

/** GCP runs its MCP server as a stdio subprocess, so only the Node entry registers it. */
export function registerGcpProvider(providers: ProviderRegistry): void {
  providers.registerFactory(
    "gcp",
    (cfg) => {
      const def = mcpDefinitions.get("gcp");
      if (!def) throw new Error('MCP definition for "gcp" not found');
      return new GcpProvider(def, cfg);
    },
    {
      label: "Google Cloud",
      configFields: [],
    },
  );
}

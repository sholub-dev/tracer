import type { ChatToolOptions, ProviderToolKit } from "@tracer-sh/shared";
import { McpProvider } from "../../mcp/mcp-provider.js";
import type { McpServerEntry } from "../../mcp/definitions.js";
import { createGcpDirectTools } from "./tools.js";
import { buildGcpUnifiedFragment } from "./prompts.js";
import { toolKit } from "../../tools/provider-tool-helpers.js";
import { getGcpAuth, clearGcpAuthCache, isReauthError, REAUTH_CMD } from "./gcp-auth.js";
import { timeoutSignal } from "../../lib/timeout-signal.js";
import { CONFIG } from "../../config.js";

export class GcpProvider extends McpProvider {
  constructor(server: McpServerEntry, config: Record<string, string>) {
    super(server, config, "gcp");
  }

  /**
   * Proves API access, not just MCP subprocess liveness. The cached access token can be valid while the
   * org's reauth policy already rejects it, so one Cloud Logging read (pageSize 1, the API the log tools use)
   * checks the path queries take.
   */
  protected override async probe(): Promise<void> {
    const auth = await getGcpAuth();
    if (!auth.ok) throw new Error(auth.message);

    // The API read and the MCP check are independent; running them together keeps the ping within one timeout.
    const [apiError, mcpError] = await Promise.all([
      auth.token ? this.checkApiAccess(auth.token) : null,
      super.probe().then(() => null, (err: unknown) => err),
    ]);
    if (apiError) throw new Error(apiError);
    if (mcpError) throw mcpError;
  }

  /** The reason the Cloud Logging read was refused, or null when it passed or gave no verdict. */
  private async checkApiAccess(token: string): Promise<string | null> {
    const projectId = this.config.projectId;
    if (!projectId) return null;
    try {
      const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resourceNames: [`projects/${projectId}`], pageSize: 1 }),
        signal: timeoutSignal(CONFIG.mcpPingTimeoutMs),
      });
      if (res.ok) return null;
      const detail = await res.text().catch(() => "");
      if (res.status === 401 || (res.status === 403 && isReauthError(detail))) {
        clearGcpAuthCache();
        return `GCP access was rejected. ${REAUTH_CMD}`;
      }
      return null;
    } catch {
      // A slow or unreachable Logging API says nothing about the login; the MCP check decides.
      return null;
    }
  }

  getChatTools(options: ChatToolOptions): ProviderToolKit {
    const direct = createGcpDirectTools(this, options.memoryContext, options.db, this.config.projectId);
    // With a cold MCP cache createGcpDirectTools returns no tools; the unified prompt then omits GCP,
    // so it never advertises query tools that are not registered.
    const hasTools = Object.keys(direct.tools).length > 0;
    return toolKit(direct, options.mode, hasTools ? buildGcpUnifiedFragment(this.config.projectId) : undefined);
  }
}

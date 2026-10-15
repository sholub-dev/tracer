import type {
  ChatMode,
  ChatToolWriter,
  ChatToolMemoryContext,
  ProviderToolKit,
  PingResult,
} from "@tracer-sh/shared";
import { McpProvider } from "../../mcp/mcp-provider.js";
import type { McpServerDefinition } from "../../mcp/definitions.js";
import { createGcpDirectTools, buildGcpUnifiedFragment } from "./tools.js";
import { getGcpAuth, clearGcpAuthCache, isReauthError, REAUTH_CMD } from "./gcp-auth.js";
import { timeoutSignal } from "../../lib/timeout-signal.js";
import { CONFIG } from "../../config.js";

export class GcpProvider extends McpProvider {
  constructor(definition: McpServerDefinition, config: Record<string, string>) {
    super(definition, config, "gcp");
  }

  /** Clear the token cache before re-testing so fresh credentials are used. */
  override async testConnection(): Promise<boolean> {
    clearGcpAuthCache();
    return super.testConnection();
  }

  /**
   * Override ping to prove API access, not just MCP subprocess liveness. The cached access token
   * can be valid while the org's reauth policy already rejects it, so one Cloud Logging read
   * (pageSize 1, the API the log tools use) checks the path queries take.
   */
  override async ping(): Promise<PingResult> {
    const fail = (error: string): PingResult => {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return { ok: false, error };
    };
    const auth = await getGcpAuth();
    if (!auth.ok) return fail(auth.message);

    // The API read and the MCP check are independent; running them together keeps the ping within one timeout.
    const [apiError, mcp] = await Promise.all([this.checkApiAccess(auth.token), super.ping()]);
    return apiError ? fail(apiError) : mcp;
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

  override getChatTools(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
    mode?: ChatMode;
  }): ProviderToolKit {
    const direct = createGcpDirectTools(
      this,
      options.memoryContext,
      options.db,
      this.config.projectId,
    );
    // When the MCP cache is cold/unavailable, createGcpDirectTools returns no tools. In unified
    // mode, omit the GCP prompt fragment in that case so the shared prompt never advertises GCP
    // query tools that aren't actually registered.
    const hasTools = Object.keys(direct.tools).length > 0;
    return {
      tools: direct.tools,
      afterComplete: direct.afterComplete,
      ...(options.mode === "unified"
        ? (hasTools ? { promptFragments: [buildGcpUnifiedFragment(this.config.projectId)] } : {})
        : { systemPrompt: direct.systemPrompt }),
    };
  }
}

import type {
  ChatMode,
  ChatToolWriter,
  ChatToolMemoryContext,
  ProviderToolKit,
  PingResult,
} from "@tracer-sh/shared";
import { McpProvider } from "../../mcp/mcp-provider.js";
import type { McpServerDefinition } from "../../mcp/definitions.js";
import { createGcpTools, createGcpDirectTools, GCP_DIRECT_MODE_MAX_STEPS } from "./tools.js";
import { getGcpAuth, clearGcpAuthCache } from "./gcp-auth.js";

export class GcpProvider extends McpProvider {
  constructor(definition: McpServerDefinition, config: Record<string, string>) {
    super(definition, config, "gcp");
  }

  /** Clear the token cache before re-testing so fresh credentials are used. */
  override async testConnection(): Promise<boolean> {
    clearGcpAuthCache();
    return super.testConnection();
  }

  /** Override ping to also validate OAuth credentials, not just MCP subprocess liveness. */
  override async ping(): Promise<PingResult> {
    const auth = await getGcpAuth();
    if (!auth.ok) {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return { ok: false, error: auth.message };
    }
    return super.ping();
  }

  override getChatTools(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
    mode?: ChatMode;
  }): ProviderToolKit {
    if (options.mode === "direct") {
      const direct = createGcpDirectTools(
        this,
        options.memoryContext,
        options.writer,
        options.db,
        this.config.projectId,
      );
      return {
        tools: direct.tools,
        systemPrompt: direct.systemPrompt,
        maxSteps: GCP_DIRECT_MODE_MAX_STEPS,
        afterComplete: direct.afterComplete,
      };
    }

    return createGcpTools(this, options.memoryContext, options.writer, options.db, this.config.projectId);
  }
}

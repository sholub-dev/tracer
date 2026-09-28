import type {
  ChatMode,
  ChatToolWriter,
  ChatToolMemoryContext,
  PingResult,
  ProviderToolKit,
} from "@tracer-sh/shared";
import type { PosthogProviderConfig } from "./types.js";
import { BaseProvider } from "../base.provider.js";
import { PosthogClient } from "./posthog.client.js";
import { rowsToObjects } from "./posthog-formatter.js";
import {
  createPosthogDirectTools,
  posthogUnifiedFragment,
  POSTHOG_DIRECT_MODE_MAX_STEPS,
} from "./tools.js";

export class PosthogProvider extends BaseProvider {
  readonly name = "posthog";
  readonly type = "posthog";

  private client: PosthogClient;

  constructor(config: PosthogProviderConfig) {
    super();
    this.client = new PosthogClient(config.apiKey, config.projectId, config.host);
  }

  async initialize(): Promise<void> {
    await this.testConnection();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.query("SELECT 1");
      this.connected = true;
      this.lastChecked = new Date().toISOString();
      return true;
    } catch {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return false;
    }
  }

  async ping(): Promise<PingResult> {
    try {
      await this.client.query("SELECT 1");
      this.connected = true;
      this.lastChecked = new Date().toISOString();
      return { ok: true };
    } catch (err) {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async dispose(): Promise<void> {
    this.connected = false;
  }

  async executeRawQuery(query: string): Promise<unknown> {
    return rowsToObjects(await this.client.query(query));
  }

  getChatTools(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
    mode?: ChatMode;
  }): ProviderToolKit {
    const direct = createPosthogDirectTools(
      this,
      options.memoryContext,
      options.writer,
      options.db,
    );
    return {
      tools: direct.tools,
      maxSteps: POSTHOG_DIRECT_MODE_MAX_STEPS,
      afterComplete: direct.afterComplete,
      ...(options.mode === "unified"
        ? { promptFragments: [posthogUnifiedFragment] }
        : { systemPrompt: direct.systemPrompt }),
    };
  }
}

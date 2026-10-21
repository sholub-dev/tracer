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
      await this.client.query("SELECT 1", { retry: false });
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
      await this.client.query("SELECT 1", { retry: false });
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

  async executeRawQuery(query: string, signal?: AbortSignal): Promise<unknown> {
    // A HogQL query that timed out is expensive: running it again would time out again.
    return rowsToObjects(await this.client.query(query, { retry: false, signal }));
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
      options.db,
    );
    return {
      tools: direct.tools,
      afterComplete: direct.afterComplete,
      ...(options.mode === "unified"
        ? { promptFragments: [posthogUnifiedFragment] }
        : { systemPrompt: direct.systemPrompt }),
    };
  }
}

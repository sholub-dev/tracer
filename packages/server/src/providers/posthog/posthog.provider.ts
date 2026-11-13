import type { ChatToolOptions, ProviderToolKit } from "@tracer-sh/shared";
import type { PosthogProviderConfig } from "./types.js";
import { BaseProvider } from "../base.provider.js";
import { PosthogClient } from "./posthog.client.js";
import { rowsToObjects } from "./posthog-formatter.js";
import { createPosthogDirectTools } from "./tools.js";
import { posthogUnifiedFragment } from "./prompts.js";
import { toolKit } from "../../tools/provider-tool-helpers.js";

export class PosthogProvider extends BaseProvider {
  readonly type = "posthog";

  private client: PosthogClient;

  constructor(config: PosthogProviderConfig) {
    super();
    this.client = new PosthogClient(config.apiKey, config.projectId, config.host);
  }

  protected async probe(): Promise<void> {
    await this.client.query("SELECT 1", { retry: false });
  }

  async executeRawQuery(query: string, signal?: AbortSignal): Promise<unknown> {
    // A HogQL query that timed out is expensive: running it again would time out again.
    return rowsToObjects(await this.client.query(query, { retry: false, signal }));
  }

  getChatTools(options: ChatToolOptions): ProviderToolKit {
    return toolKit(createPosthogDirectTools(this, options.memoryContext, options.db), options.mode, posthogUnifiedFragment);
  }
}

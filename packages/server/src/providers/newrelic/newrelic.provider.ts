import type {
  ChatMode,
  ChatToolWriter,
  ChatToolMemoryContext,
  PingResult,
  ProviderToolKit,
} from "@tracer-sh/shared";
import type { NewRelicProviderConfig, NrqlResult } from "./types.js";
import { BaseProvider } from "../base.provider.js";
import { NerdGraphClient, type AiIssue, type AiIssuesFilter } from "./nerdgraph.client.js";
import {
  createNewRelicDirectTools,
  nrUnifiedFragment,
  NR_DIRECT_MODE_MAX_STEPS,
} from "./tools.js";

export class NewRelicProvider extends BaseProvider {
  readonly name = "newrelic";
  readonly type = "newrelic";

  private client: NerdGraphClient;

  constructor(config: NewRelicProviderConfig) {
    super();
    this.client = new NerdGraphClient(config.apiKey, config.accountId);
  }

  async initialize(): Promise<void> {
    await this.testConnection();
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.query("SELECT count(*) FROM Transaction SINCE 1 minute ago");
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
    const response = await this.client.query(query);
    const results = response.data?.actor.account.nrql.results ?? [];
    // An UNTIL in the future returns empty buckets that read as a drop to zero.
    const now = Date.now() / 1000;
    return results.filter((r: NrqlResult) => !(typeof r.beginTimeSeconds === "number" && r.beginTimeSeconds > now));
  }

  aiIssues(filter: AiIssuesFilter, startMs: number, endMs: number): Promise<AiIssue[]> {
    return this.client.aiIssues(filter, startMs, endMs);
  }

  ackIssue(issueId: string): Promise<{ ok: true } | { error: string }> {
    return this.client.ackIssue(issueId);
  }

  resolveIssue(issueId: string): Promise<{ ok: true } | { error: string }> {
    return this.client.resolveIssue(issueId);
  }

  getChatTools(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
    mode?: ChatMode;
  }): ProviderToolKit {
    const direct = createNewRelicDirectTools(
      this,
      options.memoryContext,
      options.writer,
      options.db,
    );
    return {
      tools: direct.tools,
      maxSteps: NR_DIRECT_MODE_MAX_STEPS,
      afterComplete: direct.afterComplete,
      ...(options.mode === "unified"
        ? { promptFragments: [nrUnifiedFragment] }
        : { systemPrompt: direct.systemPrompt }),
    };
  }
}

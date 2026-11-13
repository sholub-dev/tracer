import {
  normalizeNewRelicRows,
  type ChatToolOptions,
  type ProviderToolKit,
} from "@tracer-sh/shared";
import type { NewRelicProviderConfig, NrqlResult } from "./types.js";
import { BaseProvider } from "../base.provider.js";
import { NerdGraphClient, type AiIssue, type AiIssuesFilter } from "./nerdgraph.client.js";
import { createNewRelicDirectTools } from "./tools.js";
import { nrUnifiedFragment } from "./prompts.js";
import { toolKit } from "../../tools/provider-tool-helpers.js";

export interface NrqlOutcome {
  rows: Record<string, unknown>[];
  futureRemoved: number;
  window: { begin: number; end: number } | null;
  messages: string[];
}

export class NewRelicProvider extends BaseProvider {
  readonly type = "newrelic";

  private client: NerdGraphClient;

  constructor(config: NewRelicProviderConfig) {
    super();
    this.client = new NerdGraphClient(config.apiKey, config.accountId);
  }

  protected async probe(): Promise<void> {
    await this.client.query("SELECT 1", { retry: false });
  }

  async executeRawQuery(query: string): Promise<unknown> {
    return (await this.executeNrql(query)).rows;
  }

  /** Rows plus the window and messages New Relic reports. `futureRemoved` counts rows dropped for starting after now. */
  async executeNrql(query: string, signal?: AbortSignal): Promise<NrqlOutcome> {
    const response = await this.client.query(query, { signal });
    const { results, metadata } = response.data?.actor.account.nrql ?? { results: [] };
    // An UNTIL in the future returns empty buckets that read as a drop to zero.
    const now = Date.now() / 1000;
    const kept = results.filter((r: NrqlResult) => !(typeof r.beginTimeSeconds === "number" && r.beginTimeSeconds > now));
    return {
      rows: normalizeNewRelicRows(kept.map(({ inspectedCount: _, ...row }) => row)),
      futureRemoved: results.length - kept.length,
      window: metadata?.timeWindow ?? null,
      messages: metadata?.messages ?? [],
    };
  }

  aiIssues(filter: AiIssuesFilter, startMs: number, endMs: number): Promise<AiIssue[]> {
    return this.client.aiIssues(filter, startMs, endMs);
  }

  aiIssuesPage(filter: AiIssuesFilter, startMs: number, endMs: number): Promise<{ issues: AiIssue[]; truncated: boolean }> {
    return this.client.aiIssuesPage(filter, startMs, endMs);
  }

  ackIssue(issueId: string): Promise<{ ok: true } | { error: string }> {
    return this.client.ackIssue(issueId);
  }

  resolveIssue(issueId: string): Promise<{ ok: true } | { error: string }> {
    return this.client.resolveIssue(issueId);
  }

  getChatTools(options: ChatToolOptions): ProviderToolKit {
    return toolKit(createNewRelicDirectTools(this, options.memoryContext, options.db), options.mode, nrUnifiedFragment);
  }
}

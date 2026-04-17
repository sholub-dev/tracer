import type {
  ChatMode,
  ChatToolWriter,
  ChatToolMemoryContext,
  TracerError,
  TracerLogEntry,
  TracerTransaction,
  PingResult,
  ProviderToolKit,
  TimeRange,
} from "@tracer-sh/shared";
import type { NewRelicProviderConfig, NrqlResult } from "./types.js";
import { BaseProvider } from "../base.provider.js";
import { NerdGraphClient } from "./nerdgraph.client.js";
import { errorQuery, logQuery, transactionQuery } from "./queries.js";
import {
  createNewRelicTools,
  createNewRelicDirectTools,
  newRelicSystemPrompt,
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

  async getErrors(timeRange: TimeRange): Promise<TracerError[]> {
    const nrql = errorQuery(timeRange.since, timeRange.until);
    const response = await this.client.query(nrql);
    const results = response.data?.actor.account.nrql.results ?? [];

    return results.map((r: NrqlResult, i: number) => {
      const facet = r.facet as string[] | undefined;
      return {
        id: `nr-err-${i}`,
        appName: String(facet?.[0] ?? r.appName ?? ""),
        errorClass: String(facet?.[1] ?? r["error.class"] ?? "Unknown"),
        message: String(facet?.[2] ?? r["error.message"] ?? ""),
        count: Number(r.count ?? 0),
        firstSeen: String(r.firstSeen ?? ""),
        lastSeen: String(r.lastSeen ?? ""),
        transactionName: String(facet?.[3] ?? r.name ?? ""),
        provider: "newrelic",
      };
    });
  }

  async getTransactions(timeRange: TimeRange): Promise<TracerTransaction[]> {
    const nrql = transactionQuery(timeRange.since, timeRange.until);
    const response = await this.client.query(nrql);
    const results = response.data?.actor.account.nrql.results ?? [];

    return results.map((r: NrqlResult) => ({
      name: String(r.name ?? "Unknown"),
      avgDuration: Number(r["average.duration"] ?? 0),
      throughput: Number(r.throughput ?? 0),
      errorRate: Number(r.errorRate ?? 0),
      provider: "newrelic",
    }));
  }

  async getLogs(timeRange: TimeRange, filter?: string): Promise<TracerLogEntry[]> {
    const nrql = logQuery(timeRange.since, filter, timeRange.until);
    const response = await this.client.query(nrql);
    const results = response.data?.actor.account.nrql.results ?? [];

    return results.map((r: NrqlResult) => ({
      timestamp: String(r.timestamp ?? ""),
      level: String(r.level ?? "info"),
      message: String(r.message ?? ""),
      attributes: {},
      provider: "newrelic",
    }));
  }

  async executeRawQuery(query: string): Promise<unknown> {
    const response = await this.client.query(query);
    return response.data?.actor.account.nrql.results ?? [];
  }

  getChatTools(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
    mode?: ChatMode;
  }): ProviderToolKit {
    if (options.mode === "direct") {
      const direct = createNewRelicDirectTools(
        this,
        options.memoryContext,
        options.writer,
        options.db,
      );
      return {
        tools: direct.tools,
        systemPrompt: direct.systemPrompt,
        maxSteps: NR_DIRECT_MODE_MAX_STEPS,
        afterComplete: direct.afterComplete,
      };
    }

    const tools = createNewRelicTools(
      this,
      options.memoryContext,
      options.writer,
      options.db,
    );
    return {
      tools,
      promptFragments: [newRelicSystemPrompt],
    };
  }
}

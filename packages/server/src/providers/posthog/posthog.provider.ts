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
import type { PosthogProviderConfig } from "./types.js";
import { BaseProvider } from "../base.provider.js";
import { PosthogClient } from "./posthog.client.js";
import { rowsToObjects } from "./posthog-formatter.js";
import { errorQuery, logQuery, transactionQuery } from "./queries.js";
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

  async getErrors(timeRange: TimeRange): Promise<TracerError[]> {
    const rows = rowsToObjects(await this.client.query(errorQuery(timeRange.since, timeRange.until)));

    return rows.map((r, i) => ({
      id: `ph-err-${i}`,
      appName: "", // PostHog has no service/app dimension
      errorClass: String(r.error_class ?? "Unknown"),
      message: String(r.message ?? ""),
      count: Number(r.count ?? 0),
      firstSeen: String(r.first_seen ?? ""),
      lastSeen: String(r.last_seen ?? ""),
      transactionName: String(r.fingerprint ?? ""), // exception fingerprint (dedup key)
      provider: "posthog",
    }));
  }

  async getTransactions(timeRange: TimeRange): Promise<TracerTransaction[]> {
    const rows = rowsToObjects(await this.client.query(transactionQuery(timeRange.since, timeRange.until)));

    // PostHog is not an APM: throughput is $pageview volume; duration/errorRate
    // are unavailable and reported as 0 rather than fabricated.
    return rows.map((r) => ({
      name: String(r.name ?? "Unknown"),
      avgDuration: 0,
      throughput: Number(r.throughput ?? 0),
      errorRate: 0,
      provider: "posthog",
    }));
  }

  async getLogs(timeRange: TimeRange, filter?: string): Promise<TracerLogEntry[]> {
    const rows = rowsToObjects(await this.client.query(logQuery(timeRange.since, filter, timeRange.until)));

    return rows.map((r) => ({
      timestamp: String(r.timestamp ?? ""),
      level: "info", // PostHog events have no severity level
      message: String(r.event ?? ""),
      attributes: { url: r.url, distinct_id: r.distinct_id },
      provider: "posthog",
    }));
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

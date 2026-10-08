/**
 * PostHog tool factories — builds execute_hogql tool and provider toolkit.
 */

import { z } from "zod";
import { tool } from "ai";
import type { PosthogProvider } from "./posthog.provider.js";
import type { AfterCompleteParams, ChatToolMemoryContext } from "@tracer-sh/shared";
import {
  injectMemories,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import { capQuery } from "../../lib/messages-codec.js";
import type { Db } from "../../db/driver.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import { formatHogqlCsv, toChartRows } from "./posthog-formatter.js";
import {
  directModeSystemPrompt,
  posthogUnifiedFragment,
} from "./prompts.js";

export { posthogUnifiedFragment };

// ── Shared tool builder ──

function buildExecuteHogqlTool(
  provider: PosthogProvider,
  collectedQueries: SubAgentQuery[],
) {
  return tool({
    description: "Execute a HogQL query against PostHog.",
    inputSchema: z.object({
      query: z.string().describe("The HogQL query to execute"),
      title: z.string().optional().describe("Short chart title in plain words, e.g. \"Checkout p95 latency\""),
    }),
    execute: async ({ query }) => {
      try {
        const raw = (await provider.executeRawQuery(query)) as Record<string, unknown>[];
        // Reshape time-bucketed results into New Relic's chartable contract so they plot as a
        // timeseries (no-op for non-timeseries shapes — they keep rendering as tables/badges).
        const rows = toChartRows(raw);
        collectedQueries.push({ query, results: rows });

        // The model reads the CSV built from the ORIGINAL rows: HogQL already returns time buckets
        // as readable strings under their own alias, so there is nothing to humanize — and using
        // `raw` avoids relabeling/dropping the user's columns or mangling numeric metrics.
        const csv = formatHogqlCsv(raw, query);
        return { parts: [capQuery({ type: "query" as const, query, results: rows })], analysis: csv };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        collectedQueries.push({ query, results: { error: message } });
        return { error: message };
      }
    },
    toModelOutput: ({ output }) => toolModelOutput(output),
  });
}

// ── Tool factories ──

export function createPosthogDirectTools(
  provider: PosthogProvider,
  memoryContext?: ChatToolMemoryContext,
  db?: unknown,
): { tools: Record<string, unknown>; systemPrompt: string; afterComplete: (params: AfterCompleteParams) => void } {
  const collectedQueries: SubAgentQuery[] = [];

  return {
    tools: {
      execute_hogql: buildExecuteHogqlTool(provider, collectedQueries),
      [ANALYSIS_TOOL_NAME]: beginAnalysisTool,
    },
    systemPrompt: injectMemories(directModeSystemPrompt, memoryContext),
    afterComplete: buildAfterComplete({ providerType: "posthog", db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}

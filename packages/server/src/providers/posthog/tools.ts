/**
 * PostHog tool factories: the execute_hogql tool and the direct-mode kit.
 */

import type { PosthogProvider } from "./posthog.provider.js";
import type { ChatToolMemoryContext } from "@tracer-sh/shared";
import type { ProviderQuery } from "../../agents/chat/query-records.js";
import { buildDirectTools, queryTool, type DirectTools } from "../../tools/provider-tool-helpers.js";
import { formatHogqlCsv, toChartRows } from "./posthog-formatter.js";
import { directModeSystemPrompt } from "./prompts.js";

function buildExecuteHogqlTool(
  provider: PosthogProvider,
  collectedQueries: ProviderQuery[],
) {
  return queryTool({
    description: "Execute a HogQL query against PostHog.",
    queryDescription: "The HogQL query to execute. Alias every selected value and facet with AS '<plain name>' (a person reads the column names).",
    collectedQueries,
    run: async (query, signal) => {
      const raw = (await provider.executeRawQuery(query, signal)) as Record<string, unknown>[];
      // The card gets time-bucketed rows reshaped as New Relic's timeseries so they chart. The model reads the CSV of the
      // original rows: HogQL already returns buckets as readable strings under their own alias.
      return { rows: toChartRows(raw), analysis: formatHogqlCsv(raw, query) };
    },
  });
}

export function createPosthogDirectTools(
  provider: PosthogProvider,
  memoryContext?: ChatToolMemoryContext,
  db?: unknown,
): DirectTools {
  const collectedQueries: ProviderQuery[] = [];
  return buildDirectTools({
    providerType: "posthog",
    tools: { execute_hogql: buildExecuteHogqlTool(provider, collectedQueries) },
    prompt: directModeSystemPrompt,
    collectedQueries,
    memoryContext,
    db,
  });
}

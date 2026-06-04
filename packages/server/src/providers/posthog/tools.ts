/**
 * PostHog tool factories — builds execute_hogql tool and provider toolkit.
 */

import { z } from "zod";
import { tool } from "ai";
import type { PosthogProvider } from "./posthog.provider.js";
import type { AfterCompleteParams, ChatToolMemoryContext, ChatToolWriter } from "@tracer-sh/shared";
import {
  runSubAgent,
  injectMemories,
  subAgentModelOutput,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import type { Db } from "../../db/client.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import { formatHogqlCsv } from "./posthog-formatter.js";
import {
  POSTHOG_DIRECT_MODE_MAX_STEPS,
  posthogSystemPrompt,
  directModeSystemPrompt,
  directSubAgentPrompt,
  investigateSubAgentPrompt,
} from "./prompts.js";

export { POSTHOG_DIRECT_MODE_MAX_STEPS, posthogSystemPrompt };

// ── Shared tool builder ──

function buildExecuteHogqlTool(
  provider: PosthogProvider,
  collectedQueries: SubAgentQuery[],
  writer?: ChatToolWriter,
) {
  return tool({
    description: "Execute a HogQL query against PostHog.",
    inputSchema: z.object({
      query: z.string().describe("The HogQL query to execute"),
    }),
    execute: async ({ query }, { toolCallId }) => {
      try {
        const rows = (await provider.executeRawQuery(query)) as Record<string, unknown>[];
        collectedQueries.push({ query, results: rows });

        writer?.write({
          type: "data-provider-part",
          data: { toolCallId, part: { type: "query", query, results: rows } },
        });

        const csv = formatHogqlCsv(rows);
        return { parts: [{ type: "query" as const, query, results: rows }], analysis: csv };
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
  writer?: ChatToolWriter,
  db?: unknown,
): { tools: Record<string, unknown>; systemPrompt: string; afterComplete: (params: AfterCompleteParams) => void } {
  const collectedQueries: SubAgentQuery[] = [];

  return {
    tools: {
      execute_hogql: buildExecuteHogqlTool(provider, collectedQueries, writer),
      [ANALYSIS_TOOL_NAME]: beginAnalysisTool,
    },
    systemPrompt: injectMemories(directModeSystemPrompt, memoryContext),
    afterComplete: buildAfterComplete({ providerType: "posthog", db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}

export function createPosthogTools(provider: PosthogProvider, memoryContext?: ChatToolMemoryContext, writer?: ChatToolWriter, db?: unknown) {
  return {
    hogql: tool({
      description:
        "Investigate PostHog data by describing WHAT you want to find out. A sub-agent will autonomously write and execute HogQL queries, handle error recovery, and save lessons learned. Results are AUTOMATICALLY displayed to the user in a rich UI — NEVER repeat or reformat them in your text response. If the sub-agent's analysis includes a question, use conversation context to answer it or ask the user.",
      inputSchema: z.object({
        task: z.string().describe("A clear description of what to investigate (e.g. 'find recent $exception errors on checkout and how many users they affect', 'count pageviews per path in the last hour')"),
        directive: z.enum(["DIRECT", "INVESTIGATE"]).describe(
          "DIRECT for simple lookups/counts. INVESTIGATE for root-cause analysis, user-journey tracing, cross-referencing."
        ),
      }),
      execute: async ({ task, directive }, { toolCallId, abortSignal }) => {
        if (!db) {
          return { error: "Database not available for model resolution." };
        }

        const collectedQueries: SubAgentQuery[] = [];
        const executeHogql = buildExecuteHogqlTool(provider, collectedQueries);
        const systemPrompt = directive === "DIRECT" ? directSubAgentPrompt : investigateSubAgentPrompt;

        return runSubAgent({
          providerType: "posthog",
          db: db as Db,
          systemPrompt,
          task,
          toolCallId,
          queryTools: { execute_hogql: executeHogql },
          queryToolNames: ["execute_hogql"],
          collectedQueries,
          memoryContext,
          writer,
          sessionId: writer?.sessionId,
          abortSignal,
        });
      },
      toModelOutput: ({ output }) => subAgentModelOutput(output),
    }),
  };
}

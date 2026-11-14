/**
 * Shared helpers for the provider tool factories.
 */

import { z } from "zod";
import { tool, type Tool } from "ai";
import type { AfterCompleteParams, ChatToolMemoryContext, ChatToolOptions, ProviderToolKit } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { memoryOperations } from "../db/schema.js";
import { runMemoryAgent } from "../agents/utility/memory.js";
import { injectMemories, isEmptyQuery, isFailedQuery, type ProviderQuery } from "../agents/chat/query-records.js";
import { capQuery } from "../lib/messages-codec.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "./analysis-tool.js";
import { fence, TOOL_RESULT_TAG } from "../lib/fence.js";
import { errorLine } from "../lib/error-line.js";

const ERROR_PREFIX = "Error:";

/** True for the text `toolModelOutput` gives a failed call, with or without its wrapper. */
export function isErrorText(text: string): boolean {
  return text.startsWith(ERROR_PREFIX) || text.startsWith(`<${TOOL_RESULT_TAG}>\n${ERROR_PREFIX}`);
}

/**
 * Converts tool output into a text part for model context.
 * Shared by all provider tool `toModelOutput` handlers.
 */
export function toolModelOutput(output: unknown): { type: "text"; value: string } {
  if (output && typeof output === "object" && "analysis" in output) {
    // Analysis carries raw query data, so a tag inside it must not end the wrapper.
    return { type: "text", value: fence(TOOL_RESULT_TAG, (output as { analysis: string }).analysis) };
  }
  if (output && typeof output === "object" && "error" in output) {
    // Error text comes from the data source too.
    return { type: "text", value: fence(TOOL_RESULT_TAG, `${ERROR_PREFIX} ${(output as { error: string }).error}`) };
  }
  return { type: "text", value: output !== null && typeof output === "object" ? JSON.stringify(output) : String(output) };
}

/**
 * Builds the afterComplete callback for direct-mode tool factories.
 * Runs the memory agent to extract lessons from the completed session.
 */
export function buildAfterComplete(opts: {
  providerType: string;
  db: Db | undefined;
  memoryContext: ChatToolMemoryContext | undefined;
  collectedQueries: ProviderQuery[];
}): (params: AfterCompleteParams) => void {
  const { providerType, db, memoryContext, collectedQueries } = opts;

  return (params: AfterCompleteParams) => {
    if (!db || !memoryContext) return;
    // A clean turn (rows everywhere) teaches nothing about the query language; only an error or an empty result can.
    if (!collectedQueries.some((q) => isFailedQuery(q) || isEmptyQuery(q))) return;
    const sessionId = params.sessionId;

    void (async () => {
      if (sessionId) {
        try {
          await db.insert(memoryOperations).values({
            sessionId,
            operation: "started",
          }).run();
        } catch { /* best-effort */ }
      }

      await runMemoryAgent({
        providerType,
        db,
        existingMemories: memoryContext.existingMemories,
        task: `[Direct conversation] ${params.lastUserMessage}`,
        analysisText: params.lastAssistantText,
        collectedQueries,
        sessionId,
      });
    })().catch((err) => {
      console.warn(`[memory-agent] ${providerType} direct-mode failed:`, errorLine(err));
    });
  };
}

export interface DirectTools {
  tools: Record<string, unknown>;
  systemPrompt: string;
  afterComplete: (params: AfterCompleteParams) => void;
}

/** The direct-mode kit of one provider: its tools plus the analysis tool, the prompt with its memories, and the memory callback. */
export function buildDirectTools(opts: {
  providerType: string;
  tools: Record<string, unknown>;
  prompt: string;
  collectedQueries: ProviderQuery[];
  memoryContext?: ChatToolMemoryContext;
  db?: unknown;
}): DirectTools {
  const { providerType, tools, prompt, collectedQueries, memoryContext, db } = opts;
  return {
    tools: { ...tools, [ANALYSIS_TOOL_NAME]: beginAnalysisTool },
    systemPrompt: injectMemories(prompt, memoryContext),
    afterComplete: buildAfterComplete({ providerType, db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}

/** The kit `getChatTools` returns: the shared prompt fragment in unified mode (none when `fragment` is empty), the own prompt in direct mode. */
export function toolKit(direct: DirectTools, mode: ChatToolOptions["mode"], fragment: string | undefined): ProviderToolKit {
  return {
    tools: direct.tools,
    afterComplete: direct.afterComplete,
    ...(mode === "unified"
      ? (fragment ? { promptFragments: [fragment] } : {})
      : { systemPrompt: direct.systemPrompt }),
  };
}

/** A query tool: it runs `run`, records the query for the memory agent and returns the rows for the card plus the text for the model. */
export function queryTool(opts: {
  description: string;
  queryDescription: string;
  collectedQueries: ProviderQuery[];
  run: (query: string, signal: AbortSignal | undefined) => Promise<{ rows: unknown; analysis: string }>;
  errorMessage?: (err: unknown, query: string) => string;
}): Tool {
  const { collectedQueries, run, errorMessage = (err) => (err instanceof Error ? err.message : String(err)) } = opts;
  return tool({
    description: opts.description,
    inputSchema: z.object({
      query: z.string().describe(opts.queryDescription),
      title: z.string().optional().describe("Plain title of what this query measures, read by a person and cited by the answer card."),
    }),
    execute: async ({ query }, options) => {
      try {
        const { rows, analysis } = await run(query, options?.abortSignal);
        collectedQueries.push({ query, results: rows });
        return { parts: [capQuery({ type: "query" as const, query, results: rows })], analysis };
      } catch (err) {
        const message = errorMessage(err, query);
        collectedQueries.push({ query, results: { error: message } });
        return { error: message };
      }
    },
    toModelOutput: ({ output }) => toolModelOutput(output),
  });
}

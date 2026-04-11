/**
 * New Relic tool factories — builds execute_nrql tool and provider toolkit.
 */

import { z } from "zod";
import { tool } from "ai";
import type { NewRelicProvider } from "./newrelic.provider.js";
import { formatTimestamps, type AfterCompleteParams, type ChatToolMemoryContext, type ChatToolWriter } from "@oko/shared";
import {
  runSubAgent,
  injectMemories,
  subAgentModelOutput,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import type { Db } from "../../db/client.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import { formatNrqlCsv, sanitizeNrqlRows } from "./nrql-formatter.js";
import {
  NR_DIRECT_MODE_MAX_STEPS,
  newRelicSystemPrompt,
  directModeSystemPrompt,
  directSubAgentPrompt,
  investigateSubAgentPrompt,
} from "./prompts.js";

export { NR_DIRECT_MODE_MAX_STEPS, newRelicSystemPrompt };

// ── Shared tool builder ──

function buildExecuteNrqlTool(
  provider: NewRelicProvider,
  collectedQueries: SubAgentQuery[],
  writer?: ChatToolWriter,
) {
  return tool({
    description: "Execute a NRQL query against New Relic.",
    inputSchema: z.object({
      query: z.string().describe("The NRQL query to execute"),
    }),
    execute: async ({ query }, { toolCallId }) => {
      try {
        const raw = await provider.executeRawQuery(query);
        const cleaned = sanitizeNrqlRows(raw as Record<string, unknown>[]);
        collectedQueries.push({ query, results: cleaned });

        writer?.write({
          type: "data-provider-part",
          data: { toolCallId, part: { type: "query", query, results: cleaned } },
        });

        const formatted = formatTimestamps(raw);
        const csv = formatNrqlCsv(formatted as Record<string, unknown>[]);
        return { parts: [{ type: "query" as const, query, results: cleaned }], analysis: csv };
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

export function createNewRelicDirectTools(
  provider: NewRelicProvider,
  memoryContext?: ChatToolMemoryContext,
  writer?: ChatToolWriter,
  db?: unknown,
): { tools: Record<string, unknown>; systemPrompt: string; afterComplete: (params: AfterCompleteParams) => void } {
  const collectedQueries: SubAgentQuery[] = [];

  return {
    tools: {
      execute_nrql: buildExecuteNrqlTool(provider, collectedQueries, writer),
      [ANALYSIS_TOOL_NAME]: beginAnalysisTool,
    },
    systemPrompt: injectMemories(directModeSystemPrompt, memoryContext),
    afterComplete: buildAfterComplete({ providerType: "newrelic", db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}

export function createNewRelicTools(provider: NewRelicProvider, memoryContext?: ChatToolMemoryContext, writer?: ChatToolWriter, db?: unknown) {
  return {
    nrql: tool({
      description:
        "Investigate New Relic data by describing WHAT you want to find out. A sub-agent will autonomously write and execute NRQL queries, handle error recovery, and save lessons learned. Results are AUTOMATICALLY displayed to the user in a rich UI — NEVER repeat or reformat them in your text response. If the sub-agent's analysis includes a question, use conversation context to answer it or ask the user.",
      inputSchema: z.object({
        task: z.string().describe("A clear description of what to investigate (e.g. 'find recent errors and their root causes', 'check latency for /api/users endpoint in the last hour')"),
        directive: z.enum(["DIRECT", "INVESTIGATE"]).describe(
          "DIRECT for simple lookups/counts. INVESTIGATE for root-cause analysis, tracing, cross-referencing."
        ),
      }),
      execute: async ({ task, directive }, { toolCallId, abortSignal }) => {
        if (!db) {
          return { error: "Database not available for model resolution." };
        }

        const collectedQueries: SubAgentQuery[] = [];
        const executeNrql = buildExecuteNrqlTool(provider, collectedQueries);
        const systemPrompt = directive === "DIRECT" ? directSubAgentPrompt : investigateSubAgentPrompt;

        return runSubAgent({
          providerType: "newrelic",
          db: db!,
          systemPrompt,
          task,
          toolCallId,
          queryTools: { execute_nrql: executeNrql },
          queryToolNames: ["execute_nrql"],
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

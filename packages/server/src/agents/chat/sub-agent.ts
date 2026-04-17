import { streamText, generateText, stepCountIs, smoothStream } from "ai";
import type { ProgressPart } from "@tracer-sh/shared";

import type { Db } from "../../db/client.js";
import { resolveSubAgentModel } from "../../llm/resolve.js";
import { extractUsage, addTokenUsage, emptyUsage, recordAgentRun } from "../../llm/usage.js";
import { subAgentRuns, memoryOperations } from "../../db/schema.js";
import { runMemoryAgent } from "../utility/memory.js";
import type { ChatToolWriter as StreamWriter, ChatToolMemoryContext as MemoryContext } from "@tracer-sh/shared";
import { DEFAULTS, SETTINGS_KEYS } from "../../config.js";
import { readAppSetting } from "../../db/config-reader.js";
import { getCurrentDateBlock } from "../../lib/current-context.js";

export interface SubAgentQuery {
  query: string;
  results: unknown;
}

export interface RunSubAgentOptions {
  providerType: string;
  db: Db;
  systemPrompt: string;
  task: string;
  toolCallId: string;
  /** Pre-constructed query tools (key = tool name) */
  queryTools: Record<string, any>;
  /** Tool names that trigger progress streaming on completion */
  queryToolNames: string[];
  /** Shared mutable array populated by queryTools' execute functions */
  collectedQueries: SubAgentQuery[];
  memoryContext?: MemoryContext;
  writer?: StreamWriter;
  /** Pre-resolved max steps (avoids duplicate DB read if caller already fetched it). */
  maxSteps?: number;
  sessionId?: string;
  abortSignal?: AbortSignal;
}

export interface RunSubAgentResult {
  analysis: string;
  parts: ProgressPart[];
  truncated: boolean;
  stepCount: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/** Section name used in both the injected header and prompt references that tell the LLM to check it. */
export const MEMORY_SECTION_NAME = "Corrections from Previous Sessions";

/**
 * Inject memory instructions into a system prompt, placed after the first section
 * (identity/role) to avoid the "lost in the middle" problem with long prompts.
 * Shared by sub-agent and direct mode.
 */
export function injectMemories(prompt: string, memoryContext?: MemoryContext): string {
  if (!memoryContext?.existingMemories.length) return prompt;
  const lines = memoryContext.existingMemories.filter((m) => m.note).map((m) => `- ${m.note}`);
  if (!lines.length) return prompt;
  const memoryBlock = `\n\n## ${MEMORY_SECTION_NAME}\nThese OVERRIDE any conflicting instructions above — they are verified fixes from past errors:\n${lines.join("\n")}\n`;

  // Insert after the first double-newline break (end of identity/role section)
  // so memories appear near the top rather than buried at the end.
  const firstBreak = prompt.indexOf("\n\n");
  if (firstBreak !== -1) {
    return prompt.slice(0, firstBreak) + memoryBlock + prompt.slice(firstBreak);
  }
  // Fallback: prepend if no section break found
  return memoryBlock + prompt;
}

/**
 * Converts a sub-agent tool output into a text part for model context.
 * Handles normal results, errors, aborted runs, and malformed outputs.
 */
export function subAgentModelOutput(output: unknown): { type: "text"; value: string } {
  if (!output) return { type: "text", value: "(no output)" };
  if (typeof output === "object" && "error" in output) {
    return { type: "text", value: (output as { error: string }).error };
  }
  if (typeof output === "object" && "analysis" in output) {
    return { type: "text", value: (output as RunSubAgentResult).analysis };
  }
  return { type: "text", value: "(aborted)" };
}

export async function runSubAgent(opts: RunSubAgentOptions): Promise<RunSubAgentResult | { error: string }> {
  const {
    providerType, db, systemPrompt, task, toolCallId,
    queryTools, queryToolNames, collectedQueries,
    memoryContext, writer, sessionId, abortSignal,
  } = opts;

  const resolved = resolveSubAgentModel(db, providerType);
  if ("error" in resolved) {
    return { error: resolved.error };
  }

  const MAX_STEPS = opts.maxSteps ?? readAppSetting<number>(db, SETTINGS_KEYS.subAgentMaxSteps) ?? DEFAULTS.subAgentMaxSteps;
  const startTime = Date.now();

  // Build sub-agent tool set
  const subAgentTools: Record<string, any> = { ...queryTools };

  const fullSystemPrompt = injectMemories(systemPrompt, memoryContext)
    + "\n\n" + getCurrentDateBlock(db);

  const queryToolNameSet = new Set(queryToolNames);
  const prompt = `Task: ${task}`;

  // Retry logic: max 1 retry on failure.
  // On attempt 0, suppress streaming to prevent polluting the UI if a retry follows.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    collectedQueries.length = 0;
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    const activeWriter = isLastAttempt ? writer : undefined;
    try {
      const result = streamText({
        model: resolved.model,
        temperature: 0,
        system: fullSystemPrompt,
        prompt,
        tools: subAgentTools,
        stopWhen: stepCountIs(MAX_STEPS),
        providerOptions: resolved.providerOptions,
        experimental_transform: smoothStream({ chunking: "word" }),
        abortSignal,
      });

      let analysisText = "";
      let stepCount = 0;
      let lastFinishReason: string | undefined;
      const parts: ProgressPart[] = [];

      for await (const part of result.fullStream) {
        if (part.type === "tool-call" && queryToolNameSet.has(part.toolName)) {
          activeWriter?.write({
            type: "data-provider-part",
            data: { toolCallId, part: { type: "tool-call", toolName: part.toolName } },
          });
        } else if (part.type === "tool-result" && queryToolNameSet.has(part.toolName)) {
          const lastQuery = collectedQueries[collectedQueries.length - 1];
          if (lastQuery) {
            const qPart: ProgressPart = { type: "query", query: lastQuery.query, results: lastQuery.results };
            parts.push(qPart);
            activeWriter?.write({
              type: "data-provider-part",
              data: { toolCallId, part: qPart },
            });
          }
        } else if (part.type === "reasoning-delta") {
          // Coalesce consecutive reasoning deltas into one part
          const lastPart = parts[parts.length - 1];
          if (lastPart?.type === "reasoning") {
            lastPart.content += part.text;
          } else {
            parts.push({ type: "reasoning", content: part.text });
          }
          activeWriter?.write({
            type: "data-provider-part",
            data: { toolCallId, part: { type: "reasoning-delta", delta: part.text } },
          });
        } else if (part.type === "text-delta") {
          analysisText += part.text;
          // Coalesce consecutive text deltas into one part
          const lastPart = parts[parts.length - 1];
          if (lastPart?.type === "text") {
            lastPart.content += part.text;
          } else {
            parts.push({ type: "text", content: part.text });
          }
          activeWriter?.write({
            type: "data-provider-part",
            data: { toolCallId, part: { type: "text-delta", delta: part.text } },
          });
        } else if (part.type === "finish-step") {
          stepCount++;
          if ("finishReason" in part) {
            lastFinishReason = part.finishReason as string;
          }
        }
      }

      const totalUsage = await result.totalUsage;
      const investigationUsage = extractUsage(totalUsage, resolved.modelId);

      const truncated = stepCount >= MAX_STEPS;
      let extraUsage = emptyUsage(resolved.modelId);

      // Append truncation notice if the sub-agent hit the step limit
      if (truncated) {
        let summary: string;
        try {
          // Build rich query context with results snippets
          const MAX_QUERY_CONTEXT = 12000;
          let queryContextLen = 0;
          const querySummaries = collectedQueries.map((q, i) => {
            if (queryContextLen >= MAX_QUERY_CONTEXT) return null;
            const queryStr = q.query.slice(0, 300);
            let resultSnippet: string;
            const isErr = q.results && typeof q.results === "object" && "error" in (q.results as Record<string, unknown>);
            if (isErr) {
              const errMsg = String((q.results as Record<string, unknown>).error ?? "unknown error").slice(0, 500);
              resultSnippet = `ERROR: ${errMsg}`;
            } else if (q.results != null) {
              resultSnippet = JSON.stringify(q.results).slice(0, 500);
            } else {
              resultSnippet = "(no results)";
            }
            const entry = `<query index="${i + 1}">
<request>${queryStr}</request>
<result>${resultSnippet}</result>
</query>`;
            if (queryContextLen + entry.length > MAX_QUERY_CONTEXT) return null;
            queryContextLen += entry.length;
            return entry;
          }).filter(Boolean).join("\n");

          const summaryResult = await generateText({
            model: resolved.model,
            temperature: 0,
            system: `You distill a truncated investigation into a factual briefing. The orchestrator has ZERO access to raw query results — your summary is its ONLY source of information. Everything not in this summary is permanently lost.

Rules:
- **Preserve every concrete data point.** Service names, error messages, counts, percentages, timestamps, trace IDs, hostnames, endpoints — if the investigation discovered it, include it. The orchestrator cannot recover data you omit.
- **Distinguish observations from inferences.** If the sub-agent stated a conclusion, note whether it was directly supported by query data or was an inference. Flag any unsupported claims.
- **Capture query patterns.** Which filters, field names, and syntax worked vs. failed — so follow-up calls avoid repeating mistakes.
- **List remaining work as actionable tasks.** Each item must be a complete standalone brief with all necessary context (identifiers, filters, event types) so a fresh sub-agent could execute it immediately.
- Complete all four sections fully — never cut off mid-sentence.
- Do NOT repeat the original task description.`,
            prompt: `<context>
<task>${task}</task>
<steps_used>${stepCount} of ${MAX_STEPS}</steps_used>
<query_count>${collectedQueries.length}</query_count>
</context>

<queries>
${querySummaries}
</queries>

<partial_analysis>
${analysisText.slice(0, 10000)}
</partial_analysis>

<instructions>
Write exactly four sections. Every section must be complete — do not leave any sentence unfinished.

1. **Completed work** — bullet list of what was queried and investigated
2. **Key findings** — bullet list of specific data points, values, and conclusions discovered so far (include numbers, names, IDs). Label each bullet as [OBSERVATION] or [INFERENCE]. For inferences, cite the observation that supports it.
3. **Query patterns** — which query syntax, field names, and filters returned valid results vs which ones failed or returned empty. Include the correct syntax so follow-up queries can reuse it.
4. **Remaining work** — bullet list of concrete next-step queries or checks needed to finish the task. Each item must include all necessary identifiers so a fresh sub-agent can act immediately.
</instructions>`,
            maxOutputTokens: 6000,
            abortSignal,
          });
          summary = summaryResult.text;

          extraUsage = extractUsage(summaryResult.usage, resolved.modelId);
        } catch {
          // Fallback: programmatic summary
          const queryList = collectedQueries
            .map((q, i) => `${i + 1}. ${q.query.slice(0, 300)}`)
            .join("\n");
          summary = `Queries executed: ${collectedQueries.length}\n${queryList}`;
        }

        const notice = `\n\n---\n**Investigation truncated** (${stepCount}/${MAX_STEPS} steps)\n\n${summary}\n\n*Consider a follow-up call with a focused task covering the remaining work.*`;
        analysisText += notice;
        const lastPart = parts[parts.length - 1];
        if (lastPart?.type === "text") {
          lastPart.content += notice;
        } else {
          parts.push({ type: "text", content: notice });
        }
        activeWriter?.write({
          type: "data-provider-part",
          data: { toolCallId, part: { type: "text-delta", delta: notice } },
        });
      }

      // Mark the last text part as "summary" so the UI renders it with distinct styling.
      // We know it's the last message because the stream has ended.
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "text") {
          (parts[i] as { type: string }).type = "summary";
          // Tell progress store to convert its last text part too
          activeWriter?.write({
            type: "data-provider-part",
            data: { toolCallId, part: { type: "mark-summary" } },
          });
          break;
        }
      }

      const combinedUsage = addTokenUsage(investigationUsage, extraUsage);
      const subAgentResult: RunSubAgentResult = {
        analysis: analysisText,
        parts,
        truncated,
        stepCount,
        model: resolved.modelId,
        provider: providerType,
        inputTokens: combinedUsage.inputTokens,
        outputTokens: combinedUsage.outputTokens,
        reasoningTokens: combinedUsage.reasoningTokens,
        cachedInputTokens: combinedUsage.cachedInputTokens,
        cacheWriteTokens: combinedUsage.cacheWriteTokens,
      };

      const resolvedSessionId = sessionId ?? writer?.sessionId;
      const durationMs = Date.now() - startTime;

      // Fire-and-forget memory agent — logs operations to memoryOperations table
      if (memoryContext) {
        // Write "started" marker synchronously so frontend knows to poll
        if (resolvedSessionId) {
          db.insert(memoryOperations).values({
            sessionId: resolvedSessionId,
            operation: "started",
          }).run();
        }
        runMemoryAgent({
          providerType,
          db,
          existingMemories: memoryContext.existingMemories,
          task,
          analysisText,
          collectedQueries,
          sessionId: resolvedSessionId,
        }).catch((err) => {
          console.warn(`[memory-agent] ${providerType} failed:`, err);
        });
      }

      if (resolvedSessionId) {
        recordAgentRun(db, {
          sessionId: resolvedSessionId,
          agentType: providerType,
          model: resolved.modelId,
          usage: combinedUsage,
          durationMs,
        });
      }

      const errorCount = collectedQueries.filter(
        (q) => q.results && typeof q.results === "object" && "error" in (q.results as Record<string, unknown>),
      ).length;

      try {
        db.insert(subAgentRuns)
          .values({
            id: crypto.randomUUID(),
            sessionId: resolvedSessionId ?? null,
            provider: providerType,
            task: task.slice(0, 500),
            queryCount: collectedQueries.length,
            errorCount,
            stepCount,
            truncated: truncated ? 1 : 0,
            durationMs,
            finishReason: lastFinishReason ?? null,
          })
          .run();
      } catch (err) {
        console.warn(`[sub-agent-telemetry] Failed to record run:`, err);
      }

      return subAgentResult;
    } catch (err) {
      // Don't retry if the request was aborted by the client
      if (abortSignal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        return { error: "Request was aborted." };
      }
      if (attempt === 0) {
        console.warn(`[sub-agent] ${providerType} attempt 1 failed, retrying:`, err);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Sub-agent failed after 2 attempts: ${message}` };
    }
  }

  // Should not reach here, but TypeScript needs it
  return { error: "Sub-agent failed unexpectedly" };
}

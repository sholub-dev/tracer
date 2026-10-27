import type { LanguageModelUsage } from "ai";
import type { TokenUsage } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { agentRuns } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";

/** Extract a normalized TokenUsage from an AI SDK LanguageModelUsage. */
export function extractUsage(usage: LanguageModelUsage, model: string): TokenUsage {
  return {
    model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/**
 * Handler for `onLanguageModelCallEnd`: records each model call when it ends.
 * A run that fails, stops or is re-run later still counts the calls it made.
 */
export function recordEachCall(db: Db, sessionId: string, agentType: string, model: string) {
  return (event: { usage: LanguageModelUsage }) => recordAgentRun(db, { sessionId, agentType, model, usage: extractUsage(event.usage, model) });
}

/** Record a single LLM call's token usage in the agent_runs table. Best-effort. */
export async function recordAgentRun(db: Db, opts: {
  sessionId: string;
  agentType: string;
  model: string;
  usage: TokenUsage;
  durationMs?: number;
}): Promise<void> {
  try {
    await db.insert(agentRuns).values({
      id: crypto.randomUUID(),
      sessionId: opts.sessionId,
      agentType: opts.agentType,
      model: opts.model,
      inputTokens: opts.usage.inputTokens,
      outputTokens: opts.usage.outputTokens,
      cachedInputTokens: opts.usage.cachedInputTokens,
      reasoningTokens: opts.usage.reasoningTokens,
      cacheWriteTokens: opts.usage.cacheWriteTokens,
      durationMs: opts.durationMs,
    }).run();
    sessionChanged(opts.sessionId);
  } catch (err) {
    console.warn(`[agent-runs] Failed to record ${opts.agentType} run:`, err);
  }
}

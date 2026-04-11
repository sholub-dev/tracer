import type { LanguageModelUsage } from "ai";
import type { TokenUsage } from "@oko/shared";
import type { Db } from "../db/client.js";
import { agentRuns } from "../db/schema.js";

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

/** Zero-valued TokenUsage for use as an accumulator seed. */
export function emptyUsage(model = ""): TokenUsage {
  return { model, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
}

/** Sum two TokenUsage objects (keeps model from `a`). */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    model: a.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Record a single LLM call's token usage in the agent_runs table. Best-effort. */
export function recordAgentRun(db: Db, opts: {
  sessionId: string;
  agentType: string;
  model: string;
  usage: TokenUsage;
  durationMs?: number;
}): void {
  try {
    db.insert(agentRuns).values({
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
  } catch (err) {
    console.warn(`[agent-runs] Failed to record ${opts.agentType} run:`, err);
  }
}

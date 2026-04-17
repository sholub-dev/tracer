/**
 * Shared helpers for provider tool factories — eliminates duplication
 * between NR and GCP direct-mode tool setups.
 */

import type { AfterCompleteParams, ChatToolMemoryContext } from "@tracer-sh/shared";
import type { Db } from "../db/client.js";
import { memoryOperations } from "../db/schema.js";
import { runMemoryAgent } from "../agents/utility/memory.js";
import type { SubAgentQuery } from "../agents/chat/sub-agent.js";

/**
 * Converts tool output into a text part for model context.
 * Shared by all provider tool `toModelOutput` handlers.
 */
export function toolModelOutput(output: unknown): { type: "text"; value: string } {
  if (output && typeof output === "object" && "analysis" in output) {
    return { type: "text", value: (output as { analysis: string }).analysis };
  }
  if (output && typeof output === "object" && "error" in output) {
    return { type: "text", value: `Error: ${(output as { error: string }).error}` };
  }
  return { type: "text", value: String(output) };
}

/**
 * Builds the afterComplete callback for direct-mode tool factories.
 * Runs the memory agent to extract lessons from the completed session.
 */
export function buildAfterComplete(opts: {
  providerType: string;
  db: Db | undefined;
  memoryContext: ChatToolMemoryContext | undefined;
  collectedQueries: SubAgentQuery[];
}): (params: AfterCompleteParams) => void {
  const { providerType, db, memoryContext, collectedQueries } = opts;

  return (params: AfterCompleteParams) => {
    if (!db || !memoryContext) return;
    const sessionId = params.sessionId;

    if (sessionId) {
      try {
        db.insert(memoryOperations).values({
          sessionId,
          operation: "started",
        }).run();
      } catch { /* best-effort */ }
    }

    runMemoryAgent({
      providerType,
      db,
      existingMemories: memoryContext.existingMemories,
      task: `[Direct conversation] ${params.lastUserMessage}`,
      analysisText: params.lastAssistantText,
      collectedQueries,
      sessionId,
    }).catch((err) => {
      console.warn(`[memory-agent] ${providerType} direct-mode failed:`, err);
    });
  };
}

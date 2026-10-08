import { z } from "zod";
import { tool, generateText, isStepCount } from "ai";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/driver.js";
import { toolMemories } from "../../db/schema.js";
import { CONFIG } from "../../config.js";
import { resolveModel, utilityProviderOptions } from "../../llm/resolve.js";
import { recordEachCall } from "../../llm/usage.js";
import { timeoutSignal } from "../../lib/timeout-signal.js";
import { makeMemoryExecute } from "../../tools/memory-executor.js";
import { createUpdateMemoryTool, createDeleteMemoryTool } from "../../tools/memory-tools.js";
import { getDomainKnowledge } from "./memory-domain-knowledge.js";

const SYSTEM_PROMPT = `You are a Memory Reviewer. Carefully review each memory and decide what to do with it.

## What memories ARE
Memories capture corrections from REAL FAILURES in the user's specific environment. The agent tried something, it failed, and discovered what actually works. These lessons are invaluable because:
- Each user's system has unique event types, field names, and naming conventions
- Domain knowledge documents GENERIC patterns — memories document what works in THIS environment
- A memory like "Don't use X, use Y" means: the agent tried X, it returned no data, then Y worked

## Review approach
Go through EVERY memory. For each one, call review_memory with your verdict and reasoning.
Only after reviewing all memories, perform any needed updates or deletes.

## Verdicts
- **keep** — Memory captures a real correction from a failure. This is the default — most memories should be kept.
- **update** — Memory is useful but could be clearer or should be merged with another. Call update_memory after.
- **delete** — ONLY for: duplicates of another kept memory, notes contradicted by a newer note about the same field or event, OR memories that teach genuinely wrong/harmful practices that contradict domain knowledge anti-patterns. Call delete_memory after.

## When to delete a correction
- A newer note about the same field or event contradicts it: delete the older one, keep the newer.
- It duplicates another note: keep the better one.
- Otherwise keep field name corrections, event type discoveries and syntax corrections from real failures.

## Guidelines
- **Default to KEEP.** Only delete for a reason listed above.
- Merge duplicates: UPDATE the better one, DELETE the other.
- Rewrite vague notes to be specific (max 15 words). Add no fact the original note lacks.
- Delete memories that teach syntax invalid for THIS provider's query language — judge against the provider domain knowledge in the prompt, never against another provider's dialect (e.g. GROUP BY is invalid NRQL but valid HogQL).`;

const running = new Set<string>();

type OptimizerResult = { success: boolean; error?: string; stats: { kept: number; updated: number; deleted: number } };

/** One run per data source at a time: the button and the background pass share this guard. */
export async function runMemoryOptimizer(db: Db, toolName: string, sessionId?: string): Promise<OptimizerResult> {
  if (running.has(toolName)) return { success: false, error: "The optimizer is already running for this source.", stats: { kept: 0, updated: 0, deleted: 0 } };
  running.add(toolName);
  try {
    return await optimize(db, toolName, sessionId);
  } finally {
    running.delete(toolName);
  }
}

async function optimize(db: Db, toolName: string, sessionId?: string): Promise<OptimizerResult> {
  const memories = await db
    .select()
    .from(toolMemories)
    .where(eq(toolMemories.toolName, toolName))
    .orderBy(asc(toolMemories.createdAt), asc(toolMemories.id))
    .all();

  const emptyStats = { kept: 0, updated: 0, deleted: 0 };

  if (memories.length === 0) {
    return { success: true, stats: emptyStats };
  }

  const resolved = await resolveModel(db);
  if ("error" in resolved) {
    return { success: false, error: resolved.error, stats: emptyStats };
  }

  const memoryExecute = makeMemoryExecute(db, toolName);
  const stats = { kept: 0, updated: 0, deleted: 0 };

  const tools = {
    review_memory: tool({
      description: "Record your review verdict for a memory. Call this for EVERY memory before making changes.",
      inputSchema: z.object({
        id: z.number().describe("ID of the memory being reviewed"),
        verdict: z.enum(["keep", "update", "delete"]).describe("Your decision"),
        reason: z.string().describe("Brief explanation of your decision (1-2 sentences)"),
      }),
      execute: async ({ id, verdict, reason }) => {
        if (verdict === "keep") stats.kept++;
        try {
          const reviewNote = `[${verdict}] ${reason}`;
          await db.update(toolMemories)
            .set({ reviewNote })
            .where(eq(toolMemories.id, id))
            .run();
          return { reviewed: true, id, verdict };
        } catch {
          return { reviewed: true, id, verdict };
        }
      },
    }),
    update_memory: createUpdateMemoryTool(memoryExecute, {
      description: "Update an existing memory note by ID. Use after reviewing with verdict 'update'.",
      onSuccess: () => { stats.updated++; },
    }),
    delete_memory: createDeleteMemoryTool(memoryExecute, {
      description: "Delete a memory by ID. Use after reviewing with verdict 'delete'. Only for a delete reason in the instructions.",
      onSuccess: () => { stats.deleted++; },
    }),
  };

  const memoriesList = memories
    .map((m) => {
      const review = m.reviewNote ? ` (previous review: ${m.reviewNote})` : "";
      return `- [id:${m.id}] ${m.note}${review}`;
    })
    .join("\n");

  const domainKnowledge = await getDomainKnowledge(toolName);
  const domainSection = domainKnowledge
    ? `## Provider Domain Knowledge (for reference — only delete memories that say the EXACT same thing)\n${domainKnowledge}\n\n`
    : "";

  const prompt = `Review these ${memories.length} memories for provider "${toolName}".

${domainSection}## Current Memories (oldest first)
${memoriesList}

Step 1: Call review_memory for EVERY memory with your verdict and reasoning. You may batch these calls in one step.
Step 2: For memories marked "update" — call update_memory with improved text. Do this in a later step than all review_memory calls.
Step 3: For memories marked "delete" — call delete_memory (only for a delete reason in the instructions). Do this in a later step than all review_memory calls.

Be conservative. When unsure, keep the memory.`;

  try {
    await generateText({
      model: resolved.model,
      temperature: 0,
      instructions: SYSTEM_PROMPT,
      prompt,
      tools,
      stopWhen: isStepCount(30),
      providerOptions: utilityProviderOptions(resolved),
      abortSignal: timeoutSignal(CONFIG.utilityCallTimeoutMs),
      onLanguageModelCallEnd: sessionId ? recordEachCall(db, sessionId, "memory", resolved.modelId) : undefined,
    });

    return { success: true, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory-optimizer] ${toolName} failed:`, message);
    return { success: false, error: message, stats };
  }
}

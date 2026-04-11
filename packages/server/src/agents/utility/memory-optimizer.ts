import { z } from "zod";
import { tool, generateText, stepCountIs } from "ai";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { toolMemories } from "../../db/schema.js";
import { resolveUtilityModel } from "../../llm/resolve.js";
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
- **delete** — ONLY for: exact duplicates of another kept memory, OR memories that teach genuinely wrong/harmful practices that contradict domain knowledge anti-patterns. Call delete_memory after.

## What to NEVER delete
- Field name corrections ("Don't use X, use Y") — these reflect the user's actual data schema
- Event type discoveries — which event types contain which data in this environment
- Syntax corrections from real query failures
- Any "Don't X, use Y instead" pattern — this IS a failure correction by definition

## Guidelines
- **Default to KEEP.** Only delete when you are 100% certain the memory is harmful or an exact duplicate.
- Merge duplicates: UPDATE the better one, DELETE the other.
- Rewrite vague notes to be specific and actionable (max 15 words).
- Delete memories that teach bad NRQL syntax (e.g. using GROUP BY, DISTINCT, or other SQL that doesn't exist in NRQL).`;

export async function runMemoryOptimizer(
  db: Db,
  toolName: string,
): Promise<{ success: boolean; error?: string; stats: { kept: number; updated: number; deleted: number } }> {
  const memories = db
    .select()
    .from(toolMemories)
    .where(eq(toolMemories.toolName, toolName))
    .all();

  const emptyStats = { kept: 0, updated: 0, deleted: 0 };

  if (memories.length === 0) {
    return { success: true, stats: emptyStats };
  }

  const resolved = resolveUtilityModel(db);
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
          db.update(toolMemories)
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
      description: "Delete a memory by ID. Use after reviewing with verdict 'delete'. Only for clear duplicates.",
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

${domainSection}## Current Memories
${memoriesList}

Step 1: Call review_memory for EVERY memory with your verdict and reasoning.
Step 2: For memories marked "update" — call update_memory with improved text.
Step 3: For memories marked "delete" — call delete_memory (only clear duplicates or verbatim domain knowledge restating).

Be conservative. When unsure, keep the memory.`;

  try {
    await generateText({
      model: resolved.model,
      temperature: 0,
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      stopWhen: stepCountIs(30),
    });

    return { success: true, stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory-optimizer] ${toolName} failed:`, message);
    return { success: false, error: message, stats };
  }
}

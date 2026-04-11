import { z } from "zod";
import { tool, generateText, stepCountIs } from "ai";
import type { Db } from "../../db/client.js";
import { resolveUtilityModel } from "../../llm/resolve.js";
import { extractUsage, recordAgentRun } from "../../llm/usage.js";
import { makeMemoryExecute } from "../../tools/memory-executor.js";
import { createUpdateMemoryTool, createDeleteMemoryTool } from "../../tools/memory-tools.js";
import { memoryOperations } from "../../db/schema.js";
import type { SubAgentQuery } from "../chat/sub-agent.js";
import { getDomainKnowledge } from "./memory-domain-knowledge.js";

interface MemoryAgentOptions {
  providerType: string;
  db: Db;
  existingMemories: Array<{ id: number; toolName: string; note: string | null }>;
  task: string;
  analysisText: string;
  collectedQueries: SubAgentQuery[];
  sessionId?: string;
}

const SYSTEM_PROMPT = `You are a Memory Manager. Review completed sessions and extract lessons from FAILURES and STRUGGLE PATTERNS.

## MANDATORY RULE
If the session contains ANY failed queries, you MUST address each failure — either create_memory if no similar memory exists, or update_memory if an existing memory covers the same topic but could be improved. Every failure MUST result in a tool call. Do NOT skip failures.

## Purpose of memories
Memories capture corrections from real failures and discoveries in the user's specific environment. Each user's system has unique event types, field names, and naming conventions that differ from generic documentation. When the agent tries something and it fails or struggles, the correction is extremely valuable for future sessions.

## When to SAVE (create_memory)

### From failures (mandatory)
You MUST save a memory for every query failure:
- Syntax errors (HAVING, DISTINCT, GROUP BY, etc.) → "Don't use X in NRQL, use Y instead"
- Wrong field names → "Don't use X, use Y for [purpose]"
- Wrong event types → "Don't query X for [goal], use Y instead"

### From struggle patterns (evaluated)
Review the full session timeline for patterns where the agent struggled — multiple attempts with variations before finding the correct approach. Look for:
- Repeated EMPTY results with name/field/value variations followed by eventual success
- Trial-and-error discovery of entity names, field names, or event types
- Queries that had to be restructured after returning no data

Extract GENERALIZED learnings from these patterns — naming conventions, field mappings, entity structures. NOT per-query corrections.
Examples: "Services use prefix qa-, stage-, prod-", "Browser app names match APM names with ' Browser' suffix"

Only save if there is a genuine generalized learning. Skip if results were legitimately empty (e.g. no errors exist in a healthy service).

If the agent failed then corrected itself, capture the MISTAKE → CORRECTION.
If the agent failed but never found a correction, still save the mistake: "Don't use [wrong syntax/field] in NRQL"

## When NOT to save
- General best practices that aren't tied to a specific failure or struggle
- Successful patterns that didn't involve a prior failure or struggle
- User-specific data (IDs, account names, endpoints)
- Per-query empty results that are legitimately empty (no struggle pattern)

## Note format (strict)
- Max 15 words. Format: "Don't [wrong thing], use [correct thing] instead" or "[Entity type] uses [naming convention]"
- Must reference the specific mistake or discovery

## When to UPDATE (update_memory)
Session found a more precise correction for an existing memory.

## When to DELETE (delete_memory)
- Session did what a memory says not to, and it worked — the memory was wrong.
- Memory teaches genuinely bad syntax (e.g. SQL patterns that don't exist in the query language).`;

export async function runMemoryAgent(opts: MemoryAgentOptions): Promise<void> {
  const {
    providerType, db, existingMemories, task, analysisText,
    collectedQueries, sessionId,
  } = opts;

  const resolved = resolveUtilityModel(db);
  if ("error" in resolved) {
    return;
  }

  const memoryExecute = makeMemoryExecute(db, providerType, sessionId);

  const tools = {
    create_memory: tool({
      description: "Create a new memory note.",
      inputSchema: z.object({
        note: z.string().describe("The lesson to remember"),
      }),
      execute: async ({ note }) => memoryExecute({ note }),
    }),
    update_memory: createUpdateMemoryTool(memoryExecute),
    delete_memory: createDeleteMemoryTool(memoryExecute),
  };

  // Build context for the memory agent
  const memoriesSection = existingMemories.length > 0
    ? `## Existing Memories\n${existingMemories.filter((m) => m.note).map((m) => `- [id:${m.id}] ${m.note}`).join("\n")}`
    : "## Existing Memories\n(none)";

  const failures: Array<{ idx: number; query: string; error: string }> = [];
  let emptyCount = 0;
  const querySummary = collectedQueries.map((q, i) => {
    const label = `${i + 1}. ${q.query.slice(0, 500)}`;
    const isErr = q.results && typeof q.results === "object" && "error" in (q.results as Record<string, unknown>);
    if (isErr) {
      const error = String((q.results as Record<string, unknown>).error ?? "unknown").slice(0, 500);
      failures.push({ idx: i + 1, query: q.query.slice(0, 500), error });
      return `${label} → ERROR: ${error}`;
    }
    if (Array.isArray(q.results) && q.results.length === 0) {
      emptyCount++;
      return `${label} → EMPTY (no results)`;
    }
    return `${label} → OK`;
  }).join("\n");

  const domainKnowledge = await getDomainKnowledge(providerType);
  const domainSection = domainKnowledge
    ? `## Provider Domain Knowledge (already in system prompt — do NOT save these as memories)\n${domainKnowledge}\n\n`
    : "";

  let tailInstruction: string;
  if (failures.length > 0) {
    tailInstruction = `This session had ${failures.length} failed queries. You MUST address each failure with create_memory or update_memory — no exceptions.`;
    if (emptyCount > 0) tailInstruction += ` Additionally, ${emptyCount} queries returned empty results — review the session for struggle patterns.`;
  } else if (emptyCount > 0) {
    tailInstruction = `This session had no errors but ${emptyCount} queries returned empty results. Review the full session timeline for struggle patterns — repeated attempts, name variations, trial-and-error discovery. If there is a generalized learning, save it. If results were legitimately empty, respond with "No changes needed."`;
  } else {
    tailInstruction = `If the session was clean, respond with "No changes needed." and make no tool calls.`;
  }

  const failuresSection = failures.length > 0
    ? `## ⚠ FAILURES DETECTED (${failures.length}) — each MUST be addressed\n${failures.map((f) => `- Query #${f.idx}: \`${f.query}\`\n  Error: ${f.error}`).join("\n")}\n\nFor each failure above, call create_memory (or update_memory if a similar memory already exists).\n\n`
    : "";

  const prompt = `Review this completed ${providerType} session and decide what to remember.

${domainSection}${failuresSection}## Task
${task.slice(0, 1000)}

## Queries Executed (${collectedQueries.length})
${querySummary || "(none)"}

## Analysis Summary
${analysisText.slice(0, 4000)}

${memoriesSection}

${tailInstruction}`;

  try {
    const result = await generateText({
      model: resolved.model,
      temperature: 0,
      system: SYSTEM_PROMPT,
      prompt,
      tools,
      stopWhen: stepCountIs(10),
    });

    if (sessionId && result.usage) {
      const u = extractUsage(result.usage, resolved.modelId);
      recordAgentRun(db, {
        sessionId,
        agentType: "memory",
        model: resolved.modelId,
        usage: u,
      });
    }
  } catch (err) {
    console.warn(`[memory-agent] ${providerType} failed:`, err);
  } finally {
    // Always mark completion so the frontend knows the agent finished
    if (sessionId) {
      try {
        db.insert(memoryOperations).values({
          sessionId,
          operation: "completed",
        }).run();
      } catch { /* best-effort */ }
    }
  }
}

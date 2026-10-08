import { and, eq } from "drizzle-orm";
import type { Db } from "../db/driver.js";
import { toolMemories, memoryOperations } from "../db/schema.js";

export const MAX_NOTE_WORDS = 40;

export const countWords = (note: string) => note.trim().split(/\s+/).filter(Boolean).length;

/** Prompts ask for 15 words; the cap is a backstop that cuts at a sentence end, not mid-sentence. */
export function enforceNoteLength(note: string): string {
  const words = note.trim().split(/\s+/);
  if (words.length <= MAX_NOTE_WORDS) return note.trim();
  const head = words.slice(0, MAX_NOTE_WORDS).join(" ");
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "));
  return end > 0 ? head.slice(0, end + 1) : head;
}

/** Notes reach the system prompt, so one is a single plain line: no fence tags, no heading or quote markers. Never cuts words. */
export function sanitizeNote(note: string): string {
  const flat = note
    .replace(/<\s*\/?\s*memory_notes\s*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[#>]+\s*|[-*+]\s+)+/, "");
  return flat;
}

/** Two notes that differ only in case, spacing or trailing punctuation count as one. */
export function normalizeNote(note: string): string {
  return note.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?;,:\s]+$/, "");
}

/** Inserts the note unless the data source already has an equal one; returns the id of the row that holds it. */
export async function createMemory(
  db: Db,
  { toolName, note, source, sessionId }: { toolName: string; note: string; source: "agent" | "user"; sessionId?: string },
): Promise<{ id: number; note: string; created: boolean } | { error: string }> {
  const cleaned = sanitizeNote(note);
  const clean = source === "agent" ? enforceNoteLength(cleaned) : cleaned;
  if (!clean) return { error: "note is empty after cleanup" };
  const key = normalizeNote(clean);
  const same = (await db.select({ id: toolMemories.id, note: toolMemories.note }).from(toolMemories)
    .where(eq(toolMemories.toolName, toolName)).all()).find((m) => normalizeNote(sanitizeNote(m.note)) === key);
  if (same) return { id: same.id, note: clean, created: false };
  const row = await db.insert(toolMemories)
    .values({ toolName, note: clean, source, sourceSessionId: sessionId ?? null })
    .returning({ id: toolMemories.id }).get();
  return { id: row.id, note: clean, created: true };
}

export function makeMemoryExecute(db: Db, toolName: string, sessionId?: string) {
  async function logOp(operation: string, note?: string, memoryId?: number) {
    if (!sessionId) return;
    try {
      await db.insert(memoryOperations).values({
        sessionId,
        operation,
        memoryId,
        note,
      }).run();
    } catch (err) {
      console.warn(`[memory-executor] Failed to log operation:`, err);
    }
  }

  return async ({
    id,
    operation,
    note,
  }: {
    id?: number;
    operation?: "UPDATE" | "DELETE";
    note?: string;
  }) => {
    if (id !== undefined) {
      if (!operation) {
        return { error: "operation (UPDATE or DELETE) is required when id is provided" };
      }
      if (operation === "DELETE") {
        try {
          const deleted = await db.delete(toolMemories).where(and(eq(toolMemories.id, id), eq(toolMemories.toolName, toolName)))
            .returning({ id: toolMemories.id }).all();
          if (deleted.length === 0) return { error: `No memory ${id} of this data source` };
          await logOp("delete", undefined, id);
          return { deleted: true, id };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "Failed to delete memory" };
        }
      }
      if (!note) {
        return { error: "note is required for UPDATE" };
      }
      try {
        const trimmed = enforceNoteLength(sanitizeNote(note));
        if (!trimmed) return { error: "note is empty after cleanup" };
        const updated = await db.update(toolMemories)
          .set({ note: trimmed })
          .where(and(eq(toolMemories.id, id), eq(toolMemories.toolName, toolName)))
          .returning({ id: toolMemories.id })
          .all();
        if (updated.length === 0) return { error: `No memory ${id} of this data source` };
        await logOp("update", trimmed, id);
        return { updated: true, id };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "Failed to update memory" };
      }
    }
    if (!note) {
      return { error: "note is required to create a new memory" };
    }
    try {
      const result = await createMemory(db, { toolName, note, source: "agent", sessionId });
      if ("error" in result) return result;
      if (result.created) await logOp("create", result.note, result.id);
      return { saved: true, id: result.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to save memory" };
    }
  };
}

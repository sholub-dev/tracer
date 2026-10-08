import { and, eq } from "drizzle-orm";
import type { Db } from "../db/driver.js";
import { toolMemories, memoryOperations } from "../db/schema.js";

const MAX_NOTE_WORDS = 40;

/** Prompts ask for 15 words; the cap is a backstop that cuts at a sentence end, not mid-sentence. */
export function enforceNoteLength(note: string): string {
  const words = note.trim().split(/\s+/);
  if (words.length <= MAX_NOTE_WORDS) return note.trim();
  const head = words.slice(0, MAX_NOTE_WORDS).join(" ");
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "));
  return end > 0 ? head.slice(0, end + 1) : head;
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
        const trimmed = enforceNoteLength(note);
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
      const trimmed = enforceNoteLength(note);
      await db.insert(toolMemories).values({ toolName, note: trimmed }).run();
      await logOp("create", trimmed);
      return { saved: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to save memory" };
    }
  };
}

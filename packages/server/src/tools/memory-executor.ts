import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { toolMemories, memoryOperations } from "../db/schema.js";

function enforceNoteLength(note: string): string {
  const words = note.split(/\s+/);
  if (words.length <= 20) return note;
  return words.slice(0, 20).join(" ");
}

export function makeMemoryExecute(db: Db, toolName: string, sessionId?: string) {
  function logOp(operation: string, note?: string, memoryId?: number) {
    if (!sessionId) return;
    try {
      db.insert(memoryOperations).values({
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
          db.delete(toolMemories).where(eq(toolMemories.id, id)).run();
          logOp("delete", undefined, id);
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
        db.update(toolMemories)
          .set({ note: trimmed, toolName })
          .where(eq(toolMemories.id, id))
          .run();
        logOp("update", trimmed, id);
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
      db.insert(toolMemories).values({ toolName, note: trimmed }).run();
      logOp("create", trimmed);
      return { saved: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to save memory" };
    }
  };
}

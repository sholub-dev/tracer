import { eq, like, not, sql } from "drizzle-orm";
import { runInTransaction, type Db, type SetupDriver } from "./driver.js";
import { chatSessions } from "./schema.js";
import { decodeMessages, encodeMessages, PACKED_PREFIX } from "../lib/messages-codec.js";

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Rewrites chats saved as plain JSON into the packed, row-capped form. Each chat keeps its sync change time and its updated_at. */
export async function repairChats(db: Db, setupDriver: SetupDriver): Promise<void> {
  const ids = (await db.select({ id: chatSessions.id }).from(chatSessions).where(not(like(chatSessions.messages, `${PACKED_PREFIX}%`))).all()).map((r) => r.id);
  if (ids.length === 0) return;

  let repaired = 0;
  let before = 0;
  let after = 0;
  for (const id of ids) {
    try {
      const sizes = await runInTransaction(db, async (tx) => {
        const row = await tx.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, id)).get();
        if (!row || row.messages.startsWith(PACKED_PREFIX)) return null;
        const packed = encodeMessages(decodeMessages(row.messages));
        // Proxy drivers return rows as arrays, better-sqlite3 as objects.
        const synced = await tx.get<unknown[] | { changed_at: number } | undefined>(sql`SELECT changed_at FROM sync_rows WHERE tbl = 'chat_sessions' AND row_key = ${id}`);
        const changedAt = Array.isArray(synced) ? synced[0] : synced?.changed_at;
        await tx.update(chatSessions).set({ messages: packed }).where(eq(chatSessions.id, id)).run();
        if (changedAt != null) await tx.run(sql`UPDATE sync_rows SET changed_at = ${changedAt} WHERE tbl = 'chat_sessions' AND row_key = ${id}`);
        return { before: byteLength(row.messages), after: byteLength(packed) };
      });
      if (!sizes) continue;
      repaired++;
      before += sizes.before;
      after += sizes.after;
    } catch (err) {
      console.warn(`[db] Could not repair chat ${id}:`, err);
    }
  }
  if (repaired === 0) return;

  console.log(`[db] Repaired ${repaired} chats: ${before} bytes before, ${after} bytes after`);
  try {
    await setupDriver.exec("VACUUM");
  } catch (err) {
    console.warn("[db] VACUUM failed:", err);
  }
}

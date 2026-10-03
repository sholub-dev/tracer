import { eq } from "drizzle-orm";
import type { Db } from "../db/driver.js";
import { appSettings } from "../db/schema.js";

export async function getSetting(db: Db, key: string): Promise<string | undefined> {
  return (await db.select().from(appSettings).where(eq(appSettings.key, key)).get())?.value;
}

/** Remembers the device on the other side of a sync. These keys never leave this device. */
export async function recordSync(db: Db, peer: { id?: string; name: string }): Promise<void> {
  const entries: Record<string, string> = { sync_peer_name: peer.name, sync_last_at: String(Date.now()) };
  if (peer.id) entries.sync_peer_id = peer.id;
  for (const [key, value] of Object.entries(entries)) {
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
  }
}

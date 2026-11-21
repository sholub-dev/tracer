import { eq } from "drizzle-orm";
import type { Db } from "../db/driver.js";
import { appSettings } from "../db/schema.js";
import { ENV } from "../config.js";
import { isSecret } from "./crypto.js";

/** True when TRACER_SYNC turns the sync with a phone off. */
export const syncOff = () => ["off", "false", "0"].includes((ENV.TRACER_SYNC ?? "").trim().toLowerCase());

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

/** Where the last good sync with one device ended: `mine` on this clock, `theirs` on the other device's clock. */
interface SyncMark {
  mine: number;
  theirs: number;
}

async function readMarks(db: Db): Promise<Record<string, SyncMark>> {
  try { return JSON.parse((await getSetting(db, "sync_marks")) ?? "{}") as Record<string, SyncMark>; } catch { return {}; }
}

export async function getMark(db: Db, peerId: string): Promise<SyncMark | undefined> {
  return (await readMarks(db))[peerId];
}

export async function setMark(db: Db, peerId: string, mark: SyncMark): Promise<void> {
  const value = JSON.stringify({ ...(await readMarks(db)), [peerId]: mark });
  await db.insert(appSettings).values({ key: "sync_marks", value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
}

/** Peer device id -> the secret both devices stored at their first sync. It never leaves this device. */
async function readPairings(db: Db): Promise<Record<string, string>> {
  try { return JSON.parse((await getSetting(db, "sync_pairings")) ?? "{}") as Record<string, string>; } catch { return {}; }
}

export async function getPairing(db: Db, peerId: string): Promise<string | undefined> {
  const pairings = await readPairings(db);
  const secret = pairings[peerId];
  return isSecret(secret) ? secret : undefined;
}

/** `only` drops every other pairing: a phone holds the data of one computer. */
export async function setPairing(db: Db, peerId: string, secret: string, only = false): Promise<void> {
  const value = JSON.stringify({ ...(only ? {} : await readPairings(db)), [peerId]: secret });
  await db.insert(appSettings).values({ key: "sync_pairings", value }).onConflictDoUpdate({ target: appSettings.key, set: { value } }).run();
}

export const hasPairings = async (db: Db) => Object.values(await readPairings(db)).some(isSecret);

export async function clearPairings(db: Db): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, "sync_pairings")).run();
}

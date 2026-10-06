import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import type { Db } from "../db/driver.js";
import { appSettings, chatSessions, memoryOperations, monitors, monitorTriggers, syncRows, toolMemories } from "../db/schema.js";
import { exportSnapshot, importSnapshot } from "./snapshot.js";
import { exportSyncPayload, LOCAL_SETTING_KEYS, mergeSyncPayload } from "./sync.js";

async function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  return { db, sqlite, setupDriver };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const wire = async (from: Db) => clone(await exportSyncPayload(from));
const sync = async (a: Db, b: Db) => {
  const toB = await mergeSyncPayload(b, await wire(a));
  const toA = await mergeSyncPayload(a, await wire(b));
  return { toA, toB };
};
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
const logOf = async (db: Db, tbl: string, key: string) =>
  (await db.select().from(syncRows).all()).find((r) => r.tbl === tbl && r.rowKey === key);

const T0 = Date.now() + 1_000_000;

// Sets a log entry time, so tests need no sleeps.
async function stamp(db: Db, tbl: string, key: string, changedAt: number) {
  await db.update(syncRows).set({ changedAt }).where(eq(syncRows.rowKey, key)).run();
  assert.equal((await logOf(db, tbl, key))?.changedAt, changedAt);
}

async function pair() {
  const a = await freshDb();
  const b = await freshDb();
  await a.db.insert(chatSessions).values({ id: "s1", title: "One", messages: "[]" }).run();
  await a.db.insert(monitors).values({ id: "m1", name: "Errors", query: "q", condition: "{}" }).run();
  await a.db.insert(appSettings).values({ key: "chat_model", value: "claude" }).run();
  await importSnapshot(b.db, clone(await exportSnapshot(a.db)));
  return { a, b };
}

test("a full copy then a merge both ways changes nothing", async () => {
  const { a, b } = await pair();
  assert.deepEqual((await exportSyncPayload(b.db)).rows, (await exportSyncPayload(a.db)).rows);
  const { toA, toB } = await sync(a.db, b.db);
  for (const counts of [toA.applied, toA.deleted, toB.applied, toB.deleted]) assert.equal(total(counts), 0);
});

test("a new row travels; the later edit wins; an older edit loses", async () => {
  const { a, b } = await pair();
  await a.db.insert(chatSessions).values({ id: "s2", title: "Two", messages: "[]" }).run();
  const { toB } = await sync(a.db, b.db);
  assert.equal(toB.applied.chat_sessions, 1);
  assert.equal((await b.db.select().from(chatSessions).where(eq(chatSessions.id, "s2")).get())?.title, "Two");

  await b.db.update(chatSessions).set({ title: "B edit" }).where(eq(chatSessions.id, "s1")).run();
  await stamp(a.db, "chat_sessions", "s1", T0 + 1000);
  await stamp(b.db, "chat_sessions", "s1", T0 + 2000);
  await sync(a.db, b.db);
  assert.equal((await a.db.select().from(chatSessions).where(eq(chatSessions.id, "s1")).get())?.title, "B edit");

  await a.db.update(chatSessions).set({ title: "Old A edit" }).where(eq(chatSessions.id, "s1")).run();
  await stamp(a.db, "chat_sessions", "s1", T0 + 1500);
  await sync(a.db, b.db);
  assert.equal((await a.db.select().from(chatSessions).where(eq(chatSessions.id, "s1")).get())?.title, "B edit");
  assert.equal((await b.db.select().from(chatSessions).where(eq(chatSessions.id, "s1")).get())?.title, "B edit");
});

test("a delete travels with its cascaded children", async () => {
  const { a, b } = await pair();
  await a.db.insert(monitorTriggers).values({ id: "t1", monitorId: "m1", triggeredAt: 1, value: 1, windowStart: 1, windowEnd: 2, status: "muted", groups: "[]" }).run();
  await sync(a.db, b.db);
  assert.equal((await b.db.select().from(monitorTriggers).all()).length, 1);

  await a.db.delete(monitors).where(eq(monitors.id, "m1")).run();
  assert.equal((await logOf(a.db, "monitor_triggers", "t1"))?.deleted, 1);
  const { toB } = await sync(a.db, b.db);
  assert.equal(toB.deleted.monitors, 1);
  assert.equal((await b.db.select().from(monitors).all()).length, 0);
  assert.equal((await b.db.select().from(monitorTriggers).all()).length, 0);
});

test("memories with the same id on both sides both survive; operations follow the uid", async () => {
  const { a, b } = await pair();
  await a.db.insert(toolMemories).values({ toolName: "t", note: "from A" }).run();
  await b.db.insert(toolMemories).values({ toolName: "t", note: "from B" }).run();
  const memoryA = (await a.db.select().from(toolMemories).get())!;
  assert.equal(memoryA.id, 1);
  assert.equal((await b.db.select().from(toolMemories).get())!.id, 1);
  // Gives B's operation a memory id that differs from the local one after the merge.
  await b.db.insert(toolMemories).values({ toolName: "t", note: "second B" }).run();
  const second = (await b.db.select().from(toolMemories).where(eq(toolMemories.note, "second B")).get())!;
  await b.db.insert(memoryOperations).values({ sessionId: "s1", operation: "create", memoryId: second.id, note: "n" }).run();
  await a.db.insert(memoryOperations).values({ sessionId: "s1", operation: "create", memoryId: 999 }).run();

  await sync(a.db, b.db);
  for (const { db } of [a, b]) {
    assert.deepEqual((await db.select().from(toolMemories).all()).map((m) => m.note).sort(), ["from A", "from B", "second B"]);
  }
  const onA = await a.db.select().from(memoryOperations).all();
  const translated = onA.find((o) => o.note === "n")!;
  assert.equal(translated.memoryId, (await a.db.select().from(toolMemories).where(eq(toolMemories.note, "second B")).get())!.id);
  assert.equal(onA.length, 2);
  const dangling = (await b.db.select().from(memoryOperations).all()).find((o) => o.note === null)!;
  assert.equal(dangling.memoryId, null);
  assert.equal(memoryA.uid?.length, 32);
});

test("monitor run state stays per device", async () => {
  const { a, b } = await pair();
  await b.db.update(monitors).set({ enabled: 0 }).where(eq(monitors.id, "m1")).run();
  await a.db.update(monitors).set({ name: "Renamed" }).where(eq(monitors.id, "m1")).run();
  await stamp(a.db, "monitors", "m1", T0 + 5000);
  await sync(a.db, b.db);
  const onB = (await b.db.select().from(monitors).get())!;
  assert.equal(onB.name, "Renamed");
  assert.equal(onB.enabled, 0);

  await a.db.insert(monitors).values({ id: "m2", name: "New", query: "q", condition: "{}", lastStatus: "alerting", lastCheckedAt: 5 }).run();
  await sync(a.db, b.db);
  const arrived = (await b.db.select().from(monitors).where(eq(monitors.id, "m2")).get())!;
  assert.equal(arrived.enabled, 0);
  assert.equal(arrived.lastStatus, "ok");

  const before = await logOf(a.db, "monitors", "m1");
  await a.db.update(monitors).set({ lastCheckedAt: 9, lastStatus: "alerting", lastError: "x", enabled: 0, updatedAt: 99 }).where(eq(monitors.id, "m1")).run();
  assert.deepEqual(await logOf(a.db, "monitors", "m1"), before);
});

test("opening an unread session does not make a stale copy win", async () => {
  const { a, b } = await pair();
  await a.db.update(chatSessions).set({ messages: '["newer"]' }).where(eq(chatSessions.id, "s1")).run();
  await stamp(a.db, "chat_sessions", "s1", T0 + 5000);
  const before = await logOf(b.db, "chat_sessions", "s1");
  await b.db.update(chatSessions).set({ status: "idle" }).where(eq(chatSessions.id, "s1")).run();
  assert.deepEqual(await logOf(b.db, "chat_sessions", "s1"), before);
  await sync(a.db, b.db);
  assert.equal((await a.db.select().from(chatSessions).get())!.messages, '["newer"]');
  assert.equal((await b.db.select().from(chatSessions).get())!.messages, '["newer"]');
});

test("device settings never travel", async () => {
  const { a, b } = await pair();
  for (const key of LOCAL_SETTING_KEYS) await a.db.insert(appSettings).values({ key, value: `a-${key}` }).onConflictDoUpdate({ target: appSettings.key, set: { value: `a-${key}` } }).run();
  await b.db.insert(appSettings).values({ key: "sync_peer_id", value: "b-peer" }).run();
  const bId = (await b.db.select().from(appSettings).where(eq(appSettings.key, "device_id")).get())!.value;
  assert.notEqual(bId, "a-device_id");

  const snapshot = clone(await exportSnapshot(a.db));
  const payload = await wire(a.db);
  for (const text of [JSON.stringify(snapshot), JSON.stringify(payload)]) {
    for (const key of LOCAL_SETTING_KEYS) assert.ok(!text.includes(`a-${key}`) && !text.includes(`"${key}"`));
  }
  await mergeSyncPayload(b.db, payload);
  await importSnapshot(b.db, snapshot);
  const kept = Object.fromEntries((await b.db.select().from(appSettings).all()).filter((s) => LOCAL_SETTING_KEYS.includes(s.key)).map((s) => [s.key, s.value]));
  assert.equal(kept.device_id, bId);
  assert.equal(kept.sync_peer_id, "b-peer");
  assert.equal(await logOf(b.db, "app_settings", "device_id"), undefined);
});

test("a child whose parent was deleted on the receiver is skipped", async () => {
  const { a, b } = await pair();
  await b.db.delete(chatSessions).where(eq(chatSessions.id, "s1")).run();
  await a.db.insert(memoryOperations).values({ sessionId: "s1", operation: "create" }).run();
  const { toB } = await sync(a.db, b.db);
  assert.equal(toB.applied.memory_operations, 0);
  assert.equal((await b.db.select().from(memoryOperations).all()).length, 0);
});

test("setup twice keeps one trigger set and no duplicate entries", async () => {
  const { db, sqlite, setupDriver } = await freshDb();
  await db.insert(chatSessions).values({ id: "s1", title: "One", messages: "[]" }).run();
  const count = (sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;
  const triggers = count("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'");
  const entries = count("SELECT count(*) AS n FROM sync_rows");
  const device = sqlite.prepare("SELECT value FROM app_settings WHERE key = 'device_id'").get();
  await runSetup(setupDriver);
  assert.equal(count("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'"), triggers);
  assert.equal(count("SELECT count(*) AS n FROM sync_rows"), entries);
  assert.deepEqual(sqlite.prepare("SELECT value FROM app_settings WHERE key = 'device_id'").get(), device);
});

test("setup backfills rows that exist before the log and gives them uids", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL DEFAULT 5, updated_at INTEGER NOT NULL DEFAULT 7);
    INSERT INTO chat_sessions (id, title, messages) VALUES ('old', 'Old', '[]');
    CREATE TABLE tool_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 3);
    INSERT INTO tool_memories (tool_name, note) VALUES ('t', 'n'), ('t', 'm');
  `);
  const { setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  const rows = sqlite.prepare("SELECT tbl, changed_at FROM sync_rows WHERE tbl != 'app_settings' ORDER BY tbl, row_key").all();
  assert.deepEqual(rows, [
    { tbl: "chat_sessions", changed_at: 7000 },
    { tbl: "tool_memories", changed_at: 3000 },
    { tbl: "tool_memories", changed_at: 3000 },
  ]);
});

test("an incremental export equals the full export filtered to the changed rows", async () => {
  const { a } = await pair();
  await a.db.insert(toolMemories).values({ toolName: "t", note: "old" }).run();
  await new Promise((r) => setTimeout(r, 5));
  const since = Date.now();
  const memory = (await a.db.select().from(toolMemories).all())[0];
  await a.db.insert(memoryOperations).values({ sessionId: "s1", operation: "update", memoryId: memory.id, note: "n" }).run();
  await a.db.update(chatSessions).set({ title: "Renamed" }).where(eq(chatSessions.id, "s1")).run();
  await a.db.insert(chatSessions).values({ id: "s2", title: "Two", messages: "[]" }).run();
  await a.db.delete(monitors).where(eq(monitors.id, "m1")).run();
  await a.db.insert(appSettings).values({ key: "sync_peer_name", value: "x" }).run();

  const full = await exportSyncPayload(a.db);
  const part = await exportSyncPayload(a.db, since);
  const changed = new Set(part.rows.map((r) => `${r.tbl}\0${r.row_key}`));
  assert.ok(changed.size >= 4);
  const keys: Record<string, string> = { provider_configs: "type", app_settings: "key", tool_memories: "uid", alert_issues: "issueId", memory_operations: "uid" };
  const sorted = (rows: Record<string, any>[], prop: string) => [...rows].sort((x, y) => String(x[prop]).localeCompare(String(y[prop])));
  const operations = full.tables.memory_operations.filter((o) => changed.has(`memory_operations\0${o.uid}`));
  for (const [name, rows] of Object.entries(full.tables)) {
    const prop = keys[name] ?? "id";
    const expected = rows.filter((r) => changed.has(`${name}\0${r[prop]}`) || (name === "tool_memories" && operations.some((o) => o.memoryId === r.id)));
    assert.deepEqual(sorted(part.tables[name], prop), sorted(expected, prop), name);
  }
  // The memory did not change, yet it travels so the receiver can map the operation.
  assert.equal(part.tables.tool_memories.length, 1);
  assert.deepEqual(part.rows, full.rows.filter((r) => changed.has(`${r.tbl}\0${r.row_key}`)));
});

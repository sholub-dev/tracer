import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { chatSessions, memoryOperations, syncRows, toolMemories } from "../../db/schema.js";
import { CONFIG } from "../../config.js";
import { runMemoryOptimizer } from "./memory-optimizer.js";
import { cleanupMemories, optimizeIfDue } from "./memory-maintenance.js";
import { writeAppSetting } from "../../db/config-reader.js";

async function freshDb() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return db;
}

test("cleanup rewrites notes, removes copies, keeps the oldest and is idempotent", async () => {
  const db = await freshDb();
  await db.insert(toolMemories).values([
    { toolName: "t", note: "## Use  WHERE.", createdAt: 50, uid: "b" },
    { toolName: "t", note: "use where", createdAt: 10, uid: "z" },
    { toolName: "t", note: "Use where", createdAt: 10, uid: "a" },
    { toolName: "other", note: "use where", createdAt: 60, uid: "c" },
  ]).run();
  const [first, second, third] = await db.select().from(toolMemories).all();
  await db.insert(chatSessions).values({ id: "s", title: "t", messages: "[]", status: "done" }).run();
  await db.insert(memoryOperations).values({ sessionId: "s", operation: "create", memoryId: first.id }).run();
  assert.deepEqual(await cleanupMemories(db), { rewritten: 1, removed: 2 });
  const rows = await db.select().from(toolMemories).all();
  assert.deepEqual(rows.map((r) => r.uid).sort(), ["a", "c"], "uid breaks the tie");
  assert.equal(rows.find((r) => r.uid === "a")!.note, "Use where");
  assert.equal((await db.select().from(memoryOperations).get())!.memoryId, third.id);
  const tombstones = (await db.select().from(syncRows).all()).filter((r) => r.deleted === 1);
  assert.equal(tombstones.length, 2);
  assert.ok(second);
  assert.deepEqual(await cleanupMemories(db), { rewritten: 0, removed: 0 });
});

test("cleanup never cuts a long note", async () => {
  const db = await freshDb();
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  await db.insert(toolMemories).values({ toolName: "t", note: `## ${long}` }).run();
  await cleanupMemories(db);
  assert.equal((await db.select().from(toolMemories).get())!.note, long);
});

test("the optimizer runs when it never ran, or over the budget once a day, and not twice at once", async () => {
  const db = await freshDb();
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const ok = { success: true, stats: { kept: 0, updated: 0, deleted: 0 } };
  const run = async () => { calls++; await gate; return ok; };
  assert.equal(await optimizeIfDue(db, "t", 1000, run), false, "no notes");
  await db.insert(toolMemories).values({ toolName: "t", note: "n" }).run();
  release();
  assert.equal(await optimizeIfDue(db, "t", 1000, run), true, "never ran");
  assert.equal(await optimizeIfDue(db, "t", 1000 + 99 * 86400, run), false, "marker set, under the threshold");
  await db.insert(toolMemories).values(Array.from({ length: CONFIG.memoryMaxNotes }, (_, i) => ({ toolName: "t", note: `n${i}` }))).run();
  assert.equal(await optimizeIfDue(db, "t", 1000 + 3600, run), false, "within 24 h");
  assert.equal(await optimizeIfDue(db, "t", 1000 + 86400, run), true, "over the threshold after 24 h");
  assert.equal(calls, 2);
  await writeAppSetting(db, "memory_optimized_at:t", 0);
  assert.equal(await optimizeIfDue(db, "t", 86400, async () => ({ success: false, error: "no model", stats: ok.stats })), false);
});

test("a second optimizer run for the same source is refused while one runs", async () => {
  const db = await freshDb();
  await db.insert(toolMemories).values({ toolName: "t", note: "n" }).run();
  const [, second] = await Promise.all([runMemoryOptimizer(db, "t"), runMemoryOptimizer(db, "t")]);
  assert.match(second.error ?? "", /already running/);
});

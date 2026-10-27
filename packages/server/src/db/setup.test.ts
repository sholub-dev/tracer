import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "./node-db.js";
import { runSetup } from "./setup.js";
import { syncRows, toolMemories } from "./schema.js";

test("an existing database gains the memory provenance columns and keeps its rows", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE tool_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, note TEXT NOT NULL, review_note TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    INSERT INTO tool_memories (tool_name, note) VALUES ('newrelic', 'old note');
  `);
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  await runSetup(setupDriver);
  const row = (await db.select().from(toolMemories).all())[0];
  assert.equal(row.note, "old note");
  assert.equal(row.source, "agent");
  assert.equal(row.sourceSessionId, null);
  assert.equal(row.lastUsedAt, null);
});

test("a change to only last_used_at writes no sync row change; a note change does", async () => {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  await db.insert(toolMemories).values({ toolName: "t", note: "n" }).run();
  const logOf = async () => (await db.select().from(syncRows).all()).find((r) => r.tbl === "tool_memories");
  await db.update(syncRows).set({ changedAt: 1, localAt: 1 }).run();
  await db.update(toolMemories).set({ lastUsedAt: 99 }).run();
  assert.equal((await logOf())!.changedAt, 1);
  await db.update(toolMemories).set({ note: "m" }).where(eq(toolMemories.toolName, "t")).run();
  assert.ok((await logOf())!.changedAt > 1);
});

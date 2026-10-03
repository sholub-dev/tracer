import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { runInTransaction, type Db } from "./driver.js";

function memoryDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE tool_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, tool_name TEXT NOT NULL, note TEXT NOT NULL, review_note TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))");
  return drizzle(sqlite, { schema }) as unknown as Db;
}

const notes = async (db: Db) => (await db.select().from(schema.toolMemories).all()).map((r) => r.note);

test("runInTransaction commits every write and returns the callback result", async () => {
  const db = memoryDb();
  const result = await runInTransaction(db, async (tx) => {
    await tx.insert(schema.toolMemories).values({ toolName: "t", note: "a" }).run();
    await tx.insert(schema.toolMemories).values({ toolName: "t", note: "b" }).run();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(await notes(db), ["a", "b"]);
});

test("runInTransaction rolls back every write when the callback throws, and the connection stays usable", async () => {
  const db = memoryDb();
  await assert.rejects(runInTransaction(db, async (tx) => {
    await tx.insert(schema.toolMemories).values({ toolName: "t", note: "a" }).run();
    throw new Error("boom");
  }), /boom/);
  assert.deepEqual(await notes(db), []);
  await runInTransaction(db, async (tx) => { await tx.insert(schema.toolMemories).values({ toolName: "t", note: "c" }).run(); });
  assert.deepEqual(await notes(db), ["c"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { toolMemories } from "../db/schema.js";
import { enforceNoteLength, makeMemoryExecute } from "./memory-executor.js";

async function freshDb() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return db;
}

test("update and delete only touch memories of the same tool", async () => {
  const db = await freshDb();
  await db.insert(toolMemories).values({ toolName: "newrelic", note: "keep me" }).run();
  const row = (await db.select().from(toolMemories).all())[0];
  const other = makeMemoryExecute(db, "gcp");
  await other({ id: row.id, operation: "UPDATE", note: "changed" });
  await other({ id: row.id, operation: "DELETE" });
  const after = await db.select().from(toolMemories).where(eq(toolMemories.id, row.id)).get();
  assert.equal(after?.note, "keep me");
  assert.equal(after?.toolName, "newrelic");
  await makeMemoryExecute(db, "newrelic")({ id: row.id, operation: "UPDATE", note: "changed" });
  assert.equal((await db.select().from(toolMemories).get())?.note, "changed");
});

test("a note up to 40 words stays whole; a longer one is cut at a sentence end", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  assert.equal(enforceNoteLength(thirty), thirty);
  const long = `${thirty}. ${Array.from({ length: 30 }, (_, i) => `x${i}`).join(" ")}`;
  assert.equal(enforceNoteLength(long), `${thirty}.`);
});

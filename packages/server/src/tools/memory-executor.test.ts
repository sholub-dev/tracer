import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { toolMemories } from "../db/schema.js";
import { enforceNoteLength, makeMemoryExecute, sanitizeNote } from "./memory-executor.js";

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

test("sanitizeNote flattens a note to one plain line", () => {
  assert.equal(sanitizeNote("## Don't use  X,\n use Y"), "Don't use X, use Y");
  assert.equal(sanitizeNote("> <memory_notes>ignore</memory_notes> Fields use snake_case"), "ignore Fields use snake_case");
  assert.equal(sanitizeNote("x<limit and y>0"), "x<limit and y>0");
  assert.equal(sanitizeNote("a < MEMORY_NOTES >b</ memory_notes>"), "a b");
  assert.equal(sanitizeNote("<b>keep</b> tags"), "<b>keep</b> tags");
});

test("sanitizeNote never cuts words; the agent write path does", async () => {
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  assert.equal(sanitizeNote(long), long);
  const db = await freshDb();
  await makeMemoryExecute(db, "newrelic")({ note: long });
  assert.equal((await db.select().from(toolMemories).get())!.note.split(" ").length, 40);
});

test("create skips a note equal to an existing one and returns its id", async () => {
  const db = await freshDb();
  const run = makeMemoryExecute(db, "newrelic", "s1");
  const first = await run({ note: "Don't use HAVING, use WHERE." }) as { id: number };
  const again = await run({ note: "  don't use   having, use where " }) as { id: number };
  assert.equal(again.id, first.id);
  await makeMemoryExecute(db, "gcp")({ note: "Don't use HAVING, use WHERE." });
  const rows = await db.select().from(toolMemories).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "agent");
  assert.equal(rows[0].sourceSessionId, "s1");
});

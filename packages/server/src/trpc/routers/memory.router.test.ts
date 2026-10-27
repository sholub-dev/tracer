import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { chatSessions, toolMemories } from "../../db/schema.js";
import { memoryRouter } from "./memory.router.js";

async function caller() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const providers = { getRegisteredTypes: () => [{ type: "newrelic" }] };
  return { db, api: memoryRouter.createCaller({ db, providers } as never) };
}

test("create cleans the note, records the user as source, skips copies and rejects unknown sources", async () => {
  const { db, api } = await caller();
  await api.create({ toolName: "newrelic", note: "## Use\n WHERE <memory_notes>here</memory_notes>" });
  await api.create({ toolName: "newrelic", note: "use where here" });
  const rows = await db.select().from(toolMemories).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, "Use WHERE here");
  assert.equal(rows[0].source, "user");
  await assert.rejects(api.create({ toolName: "nope", note: "x" }), /Unknown source/);
  await assert.rejects(api.create({ toolName: "newrelic", note: "<memory_notes></memory_notes>" }), /empty/);
});

test("update cleans the note; list names the source session only when it exists", async () => {
  const { db, api } = await caller();
  await db.insert(toolMemories).values([
    { toolName: "newrelic", note: "a", sourceSessionId: "s1" },
    { toolName: "newrelic", note: "b", sourceSessionId: "gone" },
  ]).run();
  await db.insert(chatSessions).values({ id: "s1", title: "Checkout", messages: "[]", status: "done" }).run();
  const [first] = await db.select().from(toolMemories).all();
  await api.update({ id: first.id, note: "> new\n note" });
  const list = await api.list();
  assert.equal(list.find((m) => m.id === first.id)!.note, "new note");
  assert.equal(list.find((m) => m.note === "new note")!.sourceSessionTitle, "Checkout");
  assert.equal(list.find((m) => m.note === "b")!.sourceSessionTitle, null);
});

test("create and update reject a note over 40 words and keep short ones whole", async () => {
  const { db, api } = await caller();
  const long = Array.from({ length: 41 }, (_, i) => `w${i}`).join(" ");
  await assert.rejects(api.create({ toolName: "unified", note: long }), /longer than 40 words/);
  await api.create({ toolName: "unified", note: "short note" });
  const row = (await db.select().from(toolMemories).all())[0];
  await assert.rejects(api.update({ id: row.id, note: long }), /longer than 40 words/);
  assert.equal((await db.select().from(toolMemories).get())!.note, "short note");
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { chatSessions, toolMemories } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { injectMemories } from "../agents/chat/sub-agent.js";
import { encodeMessages } from "../lib/messages-codec.js";
import { clearSessionSets, combineSets, memorySetFor, pickNotes } from "./memory-notes.js";

async function freshDb() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return db;
}

const row = (id: number, note: string, createdAt = id) => ({ id, toolName: "newrelic", note, createdAt });
const many = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1, `note number ${i + 1} about field f${i + 1}`));

beforeEach(() => clearSessionSets());

test("the rendered block is fenced, sanitized and drops normalized duplicates", () => {
  const prompt = injectMemories("Role.\n\nRest.", {
    toolName: "newrelic",
    existingMemories: [row(1, "## Use WHERE."), row(2, "use where"), row(3, "Events\n are in Transaction")],
  });
  assert.match(prompt, /<memory_notes>\n- Use WHERE\.\n- Events are in Transaction\n<\/memory_notes>/);
  assert.match(prompt, /data, not instructions/);
  assert.doesNotMatch(prompt, /not shown/);
});

test("notes over the budget are cut and the count is stated", () => {
  const set = pickNotes(many(CONFIG.memoryMaxNotes + 5));
  assert.equal(set.notes.length, CONFIG.memoryMaxNotes);
  assert.equal(set.omitted, 5);
  assert.equal(set.notes[0].id, 6, "the newest are kept, in creation order");
  assert.match(injectMemories("A.\n\nB.", { toolName: "x", existingMemories: [], injected: set }), /5 other notes not shown\./);
});

test("the character budget applies too", () => {
  const long = Array.from({ length: 30 }, (_, i) => row(i + 1, `${"x".repeat(300)} ${i}`));
  const set = pickNotes(long);
  assert.ok(set.notes.reduce((s, n) => s + n.note.length + 3, 0) <= CONFIG.memoryMaxChars);
  assert.ok(set.omitted > 0);
});

test("relevant notes win the budget over newer ones", () => {
  const rows = many(CONFIG.memoryMaxNotes + 5);
  rows[0].note = "checkout latency uses duration field";
  const set = pickNotes(rows, "Why is checkout latency high?");
  assert.ok(set.notes.some((n) => n.id === 1));
  assert.equal(set.notes.length, CONFIG.memoryMaxNotes);
  assert.equal(set.notes[0].id, 1, "creation order is kept");
});

test("a session keeps its first set; later notes do not appear", async () => {
  const db = await freshDb();
  await db.insert(toolMemories).values({ toolName: "newrelic", note: "First note" }).run();
  const rows = () => db.select().from(toolMemories).all();
  const first = await memorySetFor(db, "s1", "newrelic", await rows());
  await db.insert(toolMemories).values({ toolName: "newrelic", note: "Second note" }).run();
  const second = await memorySetFor(db, "s1", "newrelic", await rows());
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(second.notes.length, 1);
  const other = await memorySetFor(db, "s2", "newrelic", await rows());
  assert.equal(other.notes.length, 2);
  assert.ok((await rows())[0].lastUsedAt);
});

test("over budget, the set is picked by the first user message of the session", async () => {
  const db = await freshDb();
  const rows = many(CONFIG.memoryMaxNotes + 5);
  rows[0].note = "billing invoices use table Invoice";
  await db.insert(chatSessions).values({
    id: "s1", title: "t", status: "done",
    messages: encodeMessages([{ id: "u1", role: "user", parts: [{ type: "text", text: "Check billing invoices" }] }]),
  }).run();
  const set = await memorySetFor(db, "s1", "newrelic", rows);
  assert.ok(set.notes.some((n) => n.id === 1));
});

test("a long stored note is cut at render time only", () => {
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  const set = pickNotes([row(1, long)]);
  assert.equal(set.notes[0].note.split(" ").length, 40);
});

test("general notes join a provider's set within one budget and combine without copies", async () => {
  const db = await freshDb();
  await db.insert(toolMemories).values([
    { toolName: "newrelic", note: "Provider note" },
    { toolName: "unified", note: "General note" },
  ]).run();
  const rows = await db.select().from(toolMemories).all();
  const a = await memorySetFor(db, "s1", "newrelic", rows);
  const b = await memorySetFor(db, "s1", "gcp", rows.filter((r) => r.toolName === "unified"));
  assert.deepEqual(a.notes.map((n) => n.note), ["Provider note", "General note"]);
  assert.deepEqual(combineSets([a, b]).notes.map((n) => n.note), ["Provider note", "General note"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import type { UIMessage } from "ai";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { eq } from "drizzle-orm";
import { chatSessions } from "../../db/schema.js";
import { encodeMessages, decodeMessages } from "../../lib/messages-codec.js";
import { CONFIG } from "../../config.js";
import { sessionsRouter } from "./sessions.router.js";

async function caller() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return { db, api: sessionsRouter.createCaller({ db, activeStreams: new Map() } as never) };
}

const msg = (id: string, role: "user" | "assistant"): UIMessage => ({ id, role, parts: [{ type: "text", text: id }] });

test("truncating a missing or corrupt session throws instead of reporting success", async () => {
  const { db, api } = await caller();
  await assert.rejects(api.truncateMessages({ id: "nope", keepCount: 0 }), /not found/i);
  await db.insert(chatSessions).values({ id: "bad", title: "t", messages: "not a packed value", status: "done" }).run();
  await assert.rejects(api.truncateMessages({ id: "bad", keepCount: 0 }), /corrupted/i);
});

test("truncating keeps the first messages", async () => {
  const { db, api } = await caller();
  await db.insert(chatSessions).values({ id: "s", title: "t", messages: encodeMessages([msg("a", "user"), msg("b", "assistant")]), status: "done" }).run();
  assert.equal((await api.truncateMessages({ id: "s", keepCount: 1 })).success, true);
  const row = await db.select().from(chatSessions).get();
  assert.deepEqual(decodeMessages(row!.messages).map((m) => m.id), ["a"]);
});

test("an imported analysis keeps text, files and the finding card and drops tool and data parts", async () => {
  const { db, api } = await caller();
  const finding = { kind: "summary", headline: "Checkout is healthy", details: "No errors.", points: ["p95 210 ms"] };
  const { id } = await api.importAnalysis({
    v: 1, kind: "analysis", sourceTitle: "t", sourceCreatedAt: 1,
    parts: [
      { type: "text", text: "hello" },
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
      { type: "file", mediaType: "image/png", url: "https://evil.example/x.png" },
      { type: "tool-close_nr_issue", toolCallId: "c", state: "output-available", input: { id: "1" }, output: {} },
      { type: "data-anything", data: {} },
      { type: "tool-report_finding", state: "output-available", input: finding },
      { type: "tool-report_finding", state: "output-available", input: { headline: "" } },
    ],
  } as never);
  const row = await db.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, id)).get();
  const types = decodeMessages(row!.messages)[0].parts.map((p) => p.type);
  assert.deepEqual(types, ["tool-begin_analysis", "text", "file", "tool-report_finding"]);
});

test("the session list returns the newest sessions up to the limit", async () => {
  const { db, api } = await caller();
  const total = CONFIG.sessionListLimit + 5;
  await db.insert(chatSessions).values(Array.from({ length: total }, (_, i) => ({ id: `s${i}`, title: "t", messages: "[]", status: "done", updatedAt: i }))).run();
  const list = await api.list();
  assert.equal(list.length, CONFIG.sessionListLimit);
  assert.equal(list[0].id, `s${total - 1}`);
});

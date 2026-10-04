import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import type { UIMessage } from "ai";
import { createNodeDb } from "./node-db.js";
import { runSetup } from "./setup.js";
import { chatSessions } from "./schema.js";
import { repairChats } from "./repair-chats.js";
import { decodeMessages, isPacked } from "../lib/messages-codec.js";
import { eq, sql } from "drizzle-orm";

const results = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
const chat = (rows: unknown[]): UIMessage[] => [
  { id: "u", role: "user", parts: [{ type: "text", text: "hi" }, { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] },
  { id: "", role: "assistant", parts: [{ type: "tool-execute_nrql", toolCallId: "t", state: "output-available", input: {}, output: { parts: [{ type: "query", query: "q", results: rows }], analysis: "csv" } }] },
] as UIMessage[];

async function setup() {
  const sqlite = new Database(":memory:");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  return { db, setupDriver };
}
const changedAt = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) =>
  (await db.get<unknown[]>(sql`SELECT changed_at FROM sync_rows WHERE tbl = 'chat_sessions' AND row_key = ${id}`))[0];

test("repair packs old chats, keeps what the UI shows, and keeps sync and update times", async () => {
  const { db, setupDriver } = await setup();
  const table = chat(results(500, (i) => ({ id: i })));
  const series = chat(results(300, (i) => ({ beginTimeSeconds: i, count: i })));
  await db.insert(chatSessions).values({ id: "a", title: "A", messages: JSON.stringify(table), status: "done", createdAt: 10, updatedAt: 20 }).run();
  await db.insert(chatSessions).values({ id: "b", title: "B", messages: JSON.stringify(series), status: "done", createdAt: 10, updatedAt: 30 }).run();
  await db.insert(chatSessions).values({ id: "c", title: "C", messages: "not json", status: "done", createdAt: 10, updatedAt: 40 }).run();
  await db.run(sql`UPDATE sync_rows SET changed_at = 12345 WHERE tbl = 'chat_sessions'`);

  await repairChats(db, setupDriver);

  const a = await db.select().from(chatSessions).where(eq(chatSessions.id, "a")).get();
  assert.ok(isPacked(a!.messages));
  const parts = (decodeMessages(a!.messages)[1].parts[0] as any).output.parts[0];
  assert.equal(parts.results.length, 100);
  assert.equal(parts.totalRows, 500);
  assert.deepEqual(decodeMessages(a!.messages)[0], table[0]);
  assert.equal(a!.updatedAt, 20);
  assert.equal(await changedAt(db, "a"), 12345);

  const b = await db.select().from(chatSessions).where(eq(chatSessions.id, "b")).get();
  assert.deepEqual(decodeMessages(b!.messages), series);
  assert.equal(await changedAt(db, "b"), 12345);

  const c = await db.select().from(chatSessions).where(eq(chatSessions.id, "c")).get();
  assert.equal(c!.messages, "not json");
});

test("a second run changes nothing", async () => {
  const { db, setupDriver } = await setup();
  await db.insert(chatSessions).values({ id: "a", title: "A", messages: JSON.stringify(chat(results(200, (i) => ({ i })))), status: "done" }).run();
  await repairChats(db, setupDriver);
  const first = await db.select().from(chatSessions).get();
  await db.run(sql`UPDATE sync_rows SET changed_at = 1 WHERE tbl = 'chat_sessions'`);
  await repairChats(db, setupDriver);
  assert.deepEqual(await db.select().from(chatSessions).get(), first);
  assert.equal(await changedAt(db, "a"), 1);
});

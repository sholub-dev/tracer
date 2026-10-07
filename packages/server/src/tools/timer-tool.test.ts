import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { Db } from "../db/driver.js";
import type { Context } from "../trpc/context.js";
import type { StartSessionOptions } from "../agents/start-session.js";
import { CONFIG } from "../config.js";
import { fireDueTimers } from "../monitors/timers.js";
import { setTimerTool } from "./timer-tool.js";

const now = () => Math.floor(Date.now() / 1000);

function memoryDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, status TEXT NOT NULL, kind TEXT,
      summary TEXT, summary_up_to INTEGER, summary_created_at INTEGER, run_scope TEXT, resumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_timers (session_id TEXT PRIMARY KEY, fire_at INTEGER, note TEXT NOT NULL, set_at INTEGER NOT NULL);
    CREATE TABLE alert_issues (
      issue_id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, trigger_id TEXT NOT NULL, session_id TEXT NOT NULL,
      condition_name TEXT NOT NULL, title TEXT NOT NULL, severity TEXT, verdict TEXT, reason TEXT, state TEXT NOT NULL, last_error TEXT,
      watch_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

async function addSession(db: Db, id: string, createdAt = now()) {
  await db.insert(schema.chatSessions).values({ id, title: id, messages: "[]", status: "idle", createdAt, updatedAt: createdAt }).run();
}

function run(db: Db, sessionId: string, input: { minutes: number; note: string }) {
  return setTimerTool(db, sessionId).execute!(input, { toolCallId: "c", messages: [] } as never);
}

const timers = async (db: Db) => await db.select().from(schema.sessionTimers).all();

test("set_timer keeps one timer per session, replaces it, and cancels with 0", async () => {
  const db = memoryDb();
  await addSession(db, "s1");
  assert.ok("dueAt" in (await run(db, "s1", { minutes: 10, note: "first" }) as object));
  assert.ok("dueAt" in (await run(db, "s1", { minutes: 30, note: "second" }) as object));
  const [row] = await timers(db);
  assert.equal((await timers(db)).length, 1);
  assert.equal(row.note, "second");
  assert.ok(Math.abs(row.fireAt! - (now() + 1800)) <= 2);
  assert.deepEqual(await run(db, "s1", { minutes: 0, note: "" }), { cancelled: true });
  assert.deepEqual(await timers(db), []);
});

test("set_timer rejects out-of-range minutes and fire times over 24h after the session started", async () => {
  const db = memoryDb();
  await addSession(db, "s1", now() - CONFIG.timerMaxAfterSessionSeconds + 600);
  assert.ok("error" in (await run(db, "s1", { minutes: 0.5, note: "x" }) as object));
  assert.ok("error" in (await run(db, "s1", { minutes: 61, note: "x" }) as object));
  assert.ok("dueAt" in (await run(db, "s1", { minutes: 1, note: "x" }) as object));
  assert.ok("error" in (await run(db, "s1", { minutes: 15, note: "x" }) as object));
  assert.ok("dueAt" in (await run(db, "s1", { minutes: 5, note: "x" }) as object));
});

test("fireDueTimers wakes a due session, pushes a busy one by 60s and leaves one not yet due", async () => {
  const db = memoryDb();
  for (const id of ["due", "busy", "later"]) await addSession(db, id);
  await db.insert(schema.sessionTimers).values([
    { sessionId: "due", fireAt: now() - 5, note: "check the deploy", setAt: now() - 600 },
    { sessionId: "busy", fireAt: now() - 5, note: "x", setAt: 0 },
    { sessionId: "later", fireAt: now() + 600, note: "x", setAt: 0 },
  ]).run();
  const context = { db, activeStreams: new Map([["busy", {}]]) } as unknown as Context;
  const started: StartSessionOptions[] = [];
  await fireDueTimers(context, async (_ctx, opts) => { started.push(opts); return { ok: true }; });

  assert.deepEqual(started.map((s) => s.sessionId), ["due"]);
  assert.match(started[0].message, /^Follow-up timer \(set .+, due .+, now .+\): check the deploy\. Check it now\.$/);
  const rows = Object.fromEntries((await timers(db)).map((r) => [r.sessionId, r.fireAt]));
  assert.equal(rows.due, undefined);
  assert.ok(Math.abs(rows.busy! - (now() + CONFIG.timerBusyRetrySeconds)) <= 2);
  assert.ok(rows.later! > now());
});

test("fireDueTimers reschedules a wake-up that fails to start", async () => {
  const db = memoryDb();
  await addSession(db, "s1");
  await db.insert(schema.sessionTimers).values({ sessionId: "s1", fireAt: now() - 5, note: "x", setAt: 0 }).run();
  const context = { db, activeStreams: new Map() } as unknown as Context;
  await fireDueTimers(context, async () => ({ error: "no model" }));
  assert.ok((await timers(db))[0].fireAt! > now());
});

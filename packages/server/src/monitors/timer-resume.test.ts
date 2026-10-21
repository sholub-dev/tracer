import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { chatSessions, sessionTimers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { setTimerTool } from "../tools/timer-tool.js";
import { settleInterruptedRuns } from "../agents/resume.js";
import type { Context } from "../trpc/context.js";
import type { StartSessionOptions } from "../agents/start-session.js";
import { fireDueTimers } from "./timers.js";
import { MonitorScheduler } from "./scheduler.js";

before(() => mock.timers.enable({ apis: ["Date"], now: Date.now() }));
after(() => mock.timers.reset());

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const provider = (connected: boolean) => ({ connected });

async function env(connected = true) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  const providers = { getAllProviders: () => [provider(connected)] };
  const context = { db, providers, activeStreams: new Map() } as unknown as Context;
  const started: StartSessionOptions[] = [];
  const start = async (_c: Context, options: StartSessionOptions) => { started.push(options); return { ok: true as const }; };
  return { db, context, providers, started, start };
}

async function chatWithTimer(db: Awaited<ReturnType<typeof env>>["db"], status = "idle", minutes = 15, id = "s1") {
  const t = now();
  await db.insert(chatSessions).values({ id, title: id, messages: "[]", status, runScope: "unified", createdAt: t, updatedAt: t }).run();
  await setTimerTool(db, id).execute!({ minutes, message: "check" }, { toolCallId: "c", messages: [] } as never);
}

const timer = (db: Awaited<ReturnType<typeof env>>["db"]) => db.select().from(sessionTimers).get();
// The scheduler's own start() cannot be injected here, so a due timer shows as a changed fire time: without a model the wake-up fails and is pushed back.
const touched = async (db: Awaited<ReturnType<typeof env>>["db"], dueAt: number) => (await timer(db))?.fireAt !== dueAt;

test("a timer set before the app slept fires when the scheduler restarts and checks at once", async () => {
  const { db, context } = await env();
  await chatWithTimer(db);
  const dueAt = (await timer(db))!.fireAt!;
  const scheduler = new MonitorScheduler(context);
  scheduler.start();
  await scheduler.stop();
  mock.timers.setTime(Date.now() + 60 * 60_000);
  scheduler.start();
  scheduler.checkNow();
  await sleep(200);
  await scheduler.stop();
  assert.ok(await touched(db, dueAt));
});

test("a cold launch with an overdue timer fires it on the first check after the providers are ready", async () => {
  const { db, context } = await env();
  await chatWithTimer(db);
  const dueAt = (await timer(db))!.fireAt!;
  mock.timers.setTime(Date.now() + 60 * 60_000);
  await settleInterruptedRuns(db);
  const scheduler = new MonitorScheduler(context);
  scheduler.start();
  scheduler.checkNow();
  await sleep(200);
  await scheduler.stop();
  assert.ok(await touched(db, dueAt));
});

test("a timer set by a reply that was still streaming is not lost when the app relaunches", async () => {
  const { db, context, started, start } = await env();
  await chatWithTimer(db, "streaming");
  mock.timers.setTime(Date.now() + 60 * 60_000);
  await settleInterruptedRuns(db);
  await fireDueTimers(context, start);
  assert.deepEqual(started.map((s) => s.sessionId), ["s1"]);
});

test("a timer behind a stream that never ends fires within a retry period of the stream ending", async () => {
  const { db, context, started, start } = await env();
  await chatWithTimer(db);
  context.activeStreams.set("s1", {} as never);
  mock.timers.setTime(Date.now() + 60 * 60_000);
  await fireDueTimers(context, start);
  assert.equal(started.length, 0);
  context.activeStreams.delete("s1");
  mock.timers.setTime(Date.now() + CONFIG.timerBusyRetrySeconds * 1000);
  await fireDueTimers(context, start);
  assert.equal(started.length, 1);
});

test("a timer waits while no provider is connected and fires on a later tick", async () => {
  const { db, context, providers, started, start } = await env(false);
  await chatWithTimer(db);
  mock.timers.setTime(Date.now() + 60 * 60_000);
  await fireDueTimers(context, start);
  assert.equal(started.length, 0);
  assert.ok((await timer(db))!.fireAt! > now());
  providers.getAllProviders = () => [provider(true)];
  mock.timers.setTime(Date.now() + CONFIG.timerBusyRetrySeconds * 1000);
  await fireDueTimers(context, start);
  assert.equal(started.length, 1);
});

test("a wake-up run that fails after it started is retried by the next tick", async () => {
  const { db, context, started, start } = await env();
  await chatWithTimer(db);
  mock.timers.setTime(Date.now() + 60 * 60_000);
  await fireDueTimers(context, start);
  assert.equal(await timer(db), undefined);
  started[0].onComplete?.({ error: "network down" });
  assert.equal(started.length, 1);
  await sleep(20);
  assert.ok(await timer(db), "the follow-up must stay pending after its run failed");
});

test("a wake-up that keeps failing is retried once, later, then the follow-up ends", async () => {
  const { db, context, started, start } = await env();
  // Its own session: the re-arm count lives for the process, across tests.
  await chatWithTimer(db, "idle", 15, "s2");
  const gaps: number[] = [];
  for (let i = 0; i < 2; i++) {
    mock.timers.setTime(Date.now() + 60 * 60_000);
    await fireDueTimers(context, start);
    started.at(-1)!.onComplete?.({ error: "invalid api key" });
    await sleep(20);
    const row = await timer(db);
    if (row) gaps.push(row.fireAt! - now());
  }
  assert.equal(started.length, 2);
  assert.deepEqual(gaps, [120]);
  assert.equal(await timer(db), undefined, "a lasting error must end the follow-up");
});

test("a wake-up that fails before its fired timer is cleared is still re-armed", async () => {
  const { db, context, start } = await env();
  await chatWithTimer(db, "idle", 15, "s3");
  mock.timers.setTime(Date.now() + 60 * 60_000);
  const failFast = async (c: Context, options: StartSessionOptions) => {
    options.onComplete?.({ error: "network down" });
    await sleep(20);
    return start(c, options);
  };
  await fireDueTimers(context, failFast);
  assert.equal((await timer(db))?.fireAt, now() + 120, "the re-arm must survive the cleanup of the fired timer");
});

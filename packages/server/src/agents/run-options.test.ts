import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { UNIFIED_SCOPE } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { buildRunOptions, chatRunOptions } from "./chat-run.js";
import { settleInterruptedRuns } from "./resume.js";
import { isWakeupTurn } from "../monitors/triage.js";

async function env() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  const provider = {
    name: "newrelic", type: "newrelic", connected: true,
    getChatTools: () => ({ tools: { close_nr_issue: { id: "unscoped" }, query: {} }, promptFragments: [] }),
  };
  const providers = { whenLoaded: async () => {}, reconnectDisconnected: async () => {}, getAllProviders: () => [provider], getProvider: () => provider };
  const context = { db, providers, activeStreams: new Map() } as unknown as Context;
  await db.insert(monitors).values({ id: "m1", name: "M", query: "q", condition: "> 0" }).run();
  await db.insert(chatSessions).values({ id: "s1", title: "t", messages: "[]", kind: "monitor" }).run();
  await db.insert(monitorTriggers).values({ id: "t1", monitorId: "m1", triggeredAt: 1, value: 1, windowStart: 0, windowEnd: 0, status: "investigating", groups: "[]", sessionId: "s1" }).run();
  return { db, context };
}

const collect = async (context: Context, options: Awaited<ReturnType<typeof buildRunOptions>>) =>
  (await options.collectTools({} as never)).tools as Record<string, unknown>;

test("user chat and unattended runs use their own retry delays", async () => {
  const { context } = await env();
  assert.equal((await buildRunOptions(context, { sessionId: "s1", interactive: true })).retryDelaysMs, CONFIG.chatRetryDelaysMs);
  assert.equal((await buildRunOptions(context, { sessionId: "s1" })).retryDelaysMs, CONFIG.agentRetryDelaysMs);
  assert.equal((await chatRunOptions(context, "s1")).retryDelaysMs, CONFIG.chatRetryDelaysMs);
});

test("a chat turn inside a monitor session has no unscoped ack or close tool", async () => {
  const { context } = await env();
  await context.db.update(monitorTriggers).set({ reported: "done" }).run();
  const tools = await collect(context, await chatRunOptions(context, "s1"));
  assert.equal(tools.close_nr_issue, undefined);
  assert.ok(tools.query && tools.set_timer && tools.report_finding);
});

test("a monitor run gets its extras and its completion hook, also when resumed", async () => {
  const { context } = await env();
  const done: unknown[] = [];
  const extras = { close_nr_issue: { id: "scoped" }, report_alert_summary: {} };
  const options = await buildRunOptions(context, { sessionId: "s1", kind: "monitor", scope: UNIFIED_SCOPE, extras, onComplete: (o) => done.push(o) });
  const collected = await options.collectTools({} as never);
  assert.deepEqual((collected.tools as Record<string, unknown>).close_nr_issue, { id: "scoped" });
  collected.afterComplete?.({} as never);
  options.onFailed?.("boom");
  assert.deepEqual(done, [{}, { error: "boom" }]);
});

test("an unreported firing gets its report tool and hook on a chat turn", async () => {
  const { context } = await env();
  const tools = await collect(context, await chatRunOptions(context, "s1"));
  assert.ok(tools.report_alert_summary);
  assert.ok((await chatRunOptions(context, "s1")).onFailed);
});

test("a restart returns the kind of a resumable run and lists ended monitor sessions", async () => {
  const { db } = await env();
  const old = Math.floor(Date.now() / 1000) - CONFIG.chatResumeMaxAgeSec - 60;
  await db.insert(chatSessions).values({ id: "fresh", title: "t", messages: "[]", kind: "monitor", status: "streaming", runScope: UNIFIED_SCOPE }).run();
  await db.insert(chatSessions).values({ id: "old", title: "t", messages: "[]", kind: "monitor", status: "streaming", runScope: UNIFIED_SCOPE, updatedAt: old }).run();
  const settled: string[] = [];
  const runs = await settleInterruptedRuns(db, settled);
  assert.deepEqual(runs, [{ id: "fresh", scope: UNIFIED_SCOPE, kind: "monitor" }]);
  assert.deepEqual(settled, ["old"]);
});

test("a wake-up message is told from a chat turn", () => {
  const user = (t: string) => ({ id: "", role: "user" as const, parts: [{ type: "text" as const, text: t }] });
  assert.equal(isWakeupTurn([user("hi"), user("Follow-up timer (set 10:00): check. Check it now.")]), true);
  assert.equal(isWakeupTurn([user("Follow-up timer (set 10:00): check."), user("thanks")]), false);
});

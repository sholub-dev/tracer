import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { Db } from "../db/driver.js";
import type { Context } from "../trpc/context.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { CONFIG } from "../config.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import type { AiIssue } from "../providers/newrelic/nerdgraph.client.js";
import { applyTriage, checkWatches, closedCheckPrompt, decide, issuesPrompt, monitorIssueTools, incidentQuery, incidentRefs, reportIssueStatusTool, wakeupExtras, type DecideInput } from "./triage.js";
import { buildMessage, firingRerun } from "./scheduler.js";
import { writeSlackConfig } from "../integrations/slack.js";
import { MONITOR_ROLE } from "./alert-summary.js";
import { fireDueTimers } from "./timers.js";
import { ensureFollowUp } from "./follow-up.js";
import { setMonitorToggles } from "./store.js";
import { settleMonitorRun } from "./scheduler.js";
import type { StartSessionOptions } from "../agents/start-session.js";

const MONITOR_QUERY = "SELECT count(*) FROM NrAiIncident WHERE event = 'open' AND policyName LIKE '%foundations%' FACET conditionName LIMIT 100 SINCE {{SINCE}} UNTIL {{UNTIL}}";

function memoryDb(globalOn = true): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE monitors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, query TEXT NOT NULL, chart_query TEXT, condition TEXT NOT NULL,
      frequency_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL, last_checked_at INTEGER, last_status TEXT NOT NULL, last_error TEXT,
      sort_order INTEGER, card_width INTEGER, alert_enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO monitors VALUES ('m1', 'M', 'newrelic', 'q', NULL, 'c', 60, 1, NULL, 'ok', NULL, NULL, NULL, 1, 0, 0);
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, status TEXT NOT NULL, kind TEXT,
      summary TEXT, summary_up_to INTEGER, summary_created_at INTEGER, run_scope TEXT, resumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO chat_sessions VALUES ('s1', 'Firing', '[]', 'idle', 'monitor', NULL, NULL, NULL, NULL, 0, 0, 0);
    CREATE TABLE session_timers (session_id TEXT PRIMARY KEY, fire_at INTEGER, note TEXT NOT NULL, set_at INTEGER NOT NULL);
    CREATE TABLE monitor_triggers (
      id TEXT PRIMARY KEY, monitor_id TEXT, triggered_at INTEGER, window_start INTEGER NOT NULL, session_id TEXT, reported TEXT, device_id TEXT, outcome TEXT
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE alert_issues (
      issue_id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, trigger_id TEXT NOT NULL, session_id TEXT NOT NULL,
      condition_name TEXT NOT NULL, title TEXT NOT NULL, severity TEXT, verdict TEXT, reason TEXT, state TEXT NOT NULL, last_error TEXT,
      watch_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO monitor_triggers (id, monitor_id, triggered_at, window_start, session_id, reported, device_id) VALUES ('t1', 'm1', 0, 0, 's1', NULL, 'dev');
    INSERT INTO app_settings VALUES ('device_id', 'dev', 0);
  `);
  if (globalOn) sqlite.prepare("INSERT INTO app_settings VALUES ('alert_triage', 'true', 0)").run();
  return drizzle(sqlite, { schema }) as unknown as Db;
}

async function addIssue(db: Db, issueId: string, fields: Partial<typeof schema.alertIssues.$inferInsert> = {}) {
  await db.insert(schema.alertIssues).values({
    issueId, monitorId: "m1", triggerId: "t1", sessionId: "s1", conditionName: "Errors", title: `Issue ${issueId}`,
    state: "pending", createdAt: 0, updatedAt: Math.floor(Date.now() / 1000), ...fields,
  }).run();
}

async function addTimer(db: Db, sessionId = "s1") {
  await db.insert(schema.sessionTimers).values({ sessionId, fireAt: Math.floor(Date.now() / 1000) + 600, note: "check", setAt: 0 }).run();
}

function fakeNewRelic(states: Record<string, AiIssue["state"]>, globalOn = true) {
  const provider = new NewRelicProvider({ type: "newrelic", apiKey: "x", accountId: "1" });
  provider.connected = true;
  const resolved: string[] = [];
  const acked: string[] = [];
  provider.ackIssue = async (id) => { acked.push(id); return { ok: true }; };
  provider.aiIssues = async (filter) => (filter.ids ?? []).filter((id) => states[id]).map((id) => ({ issueId: id, state: states[id] }) as AiIssue);
  provider.resolveIssue = async (id) => { resolved.push(id); return { ok: true }; };
  const context = { db: memoryDb(globalOn), providers: { getProvider: () => provider, getAllProviders: () => [provider] } as unknown as ProviderRegistry, activeStreams: new Map() } as Context;
  return { context, resolved, acked };
}

const base: DecideInput = { verdict: "ongoing", nrClosed: false, watchExpired: false, hasFollowUp: true, recheck: false };

test("decide follows the triage rules", () => {
  assert.deepEqual(decide(base), { outcome: "watching", ping: true });
  assert.deepEqual(decide({ ...base, verdict: "recurring", recheck: true }), { outcome: "watching", ping: false });
  assert.equal(decide({ ...base, watchExpired: true }).outcome, "left_open");
  assert.equal(decide({ ...base, watchExpired: true }).ping, true);
  assert.deepEqual(decide({ ...base, hasFollowUp: false }), { outcome: "left_open", ping: true, reason: "no re-check set" });
  assert.equal(decide({ ...base, verdict: "unknown" }).outcome, "left_open");
  assert.deepEqual(decide({ ...base, verdict: "stopped" }), { outcome: "left_open", ping: true, reason: "not closed" });
  assert.deepEqual(decide({ ...base, nrClosed: true }), { outcome: "nr_closed", ping: false });
  assert.deepEqual(decide({ ...base, nrClosed: true, verdict: "stopped" }), { outcome: "nr_closed", ping: false });
});

test("incidentQuery lists incident, policy and condition ids, keeps the rest, rejects other event types", () => {
  assert.equal(
    incidentQuery(MONITOR_QUERY),
    "SELECT uniques(incidentId), uniques(policyId), uniques(conditionId) FROM NrAiIncident WHERE event = 'open' AND policyName LIKE '%foundations%' FACET conditionName LIMIT 100 SINCE {{SINCE}} UNTIL {{UNTIL}}",
  );
  assert.equal(incidentQuery("SELECT count(*) FROM NrAiIncident SINCE 1 hour ago TIMESERIES 5 minutes"), "SELECT uniques(incidentId), uniques(policyId), uniques(conditionId) FROM NrAiIncident SINCE 1 hour ago");
  assert.equal(incidentQuery("SELECT count(*) FROM NrAiIncident SINCE 1 hour ago TIMESERIES 5 minutes SLIDE BY 1 minute"), "SELECT uniques(incidentId), uniques(policyId), uniques(conditionId) FROM NrAiIncident SINCE 1 hour ago");
  assert.equal(incidentQuery("SELECT count(*) FROM Transaction WHERE error IS true"), null);
  assert.deepEqual(
    incidentRefs([{ facet: "a", "uniques.incidentId": ["i1", "i2"], "uniques.policyId": [7, "8"], "uniques.conditionId": [42, "x"] }, { "uniques.incidentId": ["i2"] }]),
    { incidentIds: new Set(["i1", "i2"]), policyIds: [7, 8], conditionIds: [42] },
  );
});

test("report_issue_status rejects ids outside the firing and records allowed ones", async () => {
  const db = memoryDb();
  await addIssue(db, "a");
  const t = reportIssueStatusTool(db, ["a"], "s1");
  const run = (input: Parameters<NonNullable<typeof t.execute>>[0]) => t.execute!(input, { toolCallId: "c", messages: [] } as never);
  assert.ok("error" in (await run({ severity: "low", issues: [{ issueId: "a", status: "stopped", reason: "errors back to 0 since 13:58" }, { issueId: "zzz", status: "stopped", reason: "errors back to 0 since 13:58" }] }) as object));
  assert.equal((await db.select().from(schema.alertIssues).get())?.verdict, null);
  assert.deepEqual(await run({ severity: "high", issues: [{ issueId: "a", status: "ongoing", reason: "errors back to 0 since 13:58" }] }), { recorded: 1, next: "Tracer reports these statuses and your closes after the run." });
  const row = await db.select().from(schema.alertIssues).get();
  assert.equal(row?.verdict, "ongoing");
  assert.equal(row?.severity, "high");
});

const toolRun = (t: unknown, issueId: string) =>
  (t as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute({ issueId }, { toolCallId: "c", messages: [] });

test("the monitor close tool rejects an id outside the firing and names the allowed ids", async () => {
  const { context, resolved, acked } = fakeNewRelic({ a: "ACTIVATED" });
  const tools = monitorIssueTools(context, ["a", "b"], "s1");
  const error = await toolRun(tools.close_nr_issue, "zzz") as { error: string };
  assert.match(error.error, /zzz/);
  assert.match(error.error, /a, b/);
  assert.ok("error" in (await toolRun(tools.ack_nr_issue, "zzz") as object));
  assert.deepEqual([acked, resolved], [[], []]);
});

test("the monitor close tool closes and marks the issue closed, even when the ack fails", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a");
  const provider = context.providers.getProvider("newrelic") as NewRelicProvider;
  provider.ackIssue = async () => ({ error: "ack failed" });
  assert.deepEqual(await toolRun(monitorIssueTools(context, ["a"], "s1").close_nr_issue, "a"), { ok: true });
  assert.deepEqual(resolved, ["a"]);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "closed");
});

test("the monitor close tool acks before it closes", async () => {
  const { context, acked, resolved } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a");
  await toolRun(monitorIssueTools(context, ["a"], "s1").close_nr_issue, "a");
  assert.deepEqual([acked, resolved], [["a"], ["a"]]);
});

test("the monitor close tool leaves the row pending when New Relic fails to close", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a");
  const provider = context.providers.getProvider("newrelic") as NewRelicProvider;
  provider.resolveIssue = async () => ({ error: "boom" });
  assert.deepEqual(await toolRun(monitorIssueTools(context, ["a"], "s1").close_nr_issue, "a"), { error: "boom" });
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "pending");
  await context.db.update(schema.alertIssues).set({ verdict: "stopped", severity: "low" }).run();
  assert.match((await applyTriage(context, "s1", false))!.action, /Left open \(close failed\): Errors/);
});

test("the monitor ack and close tools refuse while the Settings switch is off", async () => {
  const { context, acked, resolved } = fakeNewRelic({ a: "ACTIVATED" }, false);
  await addIssue(context.db, "a");
  const tools = monitorIssueTools(context, ["a"], "s1");
  assert.match((await toolRun(tools.close_nr_issue, "a") as { error: string }).error, /turned off/);
  assert.ok("error" in (await toolRun(tools.ack_nr_issue, "a") as object));
  assert.deepEqual([acked, resolved], [[], []]);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "pending");
});

test("the close tool does not refuse a condition Tracer closed often; the prompt reports the count", async () => {
  const { context, resolved } = fakeNewRelic({ e: "ACTIVATED" });
  for (const [n, sessionId] of ["s2", "s3", "s4", "s5"].entries()) await addIssue(context.db, `old${n}`, { sessionId, state: "closed" });
  await addIssue(context.db, "e");
  assert.deepEqual(await toolRun(monitorIssueTools(context, ["e"], "s1").close_nr_issue, "e"), { ok: true });
  assert.deepEqual(resolved, ["e"]);
  const text = issuesPrompt([{ issueId: "e", conditionName: ["Errors"], title: ["Issue e"] } as unknown as AiIssue], new Map([["e", 4]])).join("\n");
  assert.match(text, /- e: Errors \| Issue e \| Tracer closed this condition 4 times on earlier firings in the last 24h/);
  assert.match(text, /keeps coming back after closes is usually recurring/);
});

test("no monitor ack or close tool exists without issues or without New Relic", () => {
  const { context } = fakeNewRelic({});
  assert.deepEqual(monitorIssueTools(context, [], "s1"), {});
  assert.deepEqual(monitorIssueTools({ ...context, providers: { getProvider: () => undefined } as unknown as ProviderRegistry }, ["a"], "s1"), {});
});

test("applyTriage records what the agent did: closed, nr_closed, left open, watching", async () => {
  const { context, resolved, acked } = fakeNewRelic({ b: "ACTIVATED", c: "ACTIVATED", d: "CLOSED", e: "ACTIVATED" });
  await addIssue(context.db, "a", { state: "closed", verdict: "stopped", severity: "high", reason: "errors back to 0 since 13:58" });
  await addIssue(context.db, "b", { verdict: "ongoing", severity: "low" });
  await addIssue(context.db, "c");
  await addIssue(context.db, "d", { verdict: "stopped", severity: "low" });
  await addIssue(context.db, "e", { verdict: "stopped", severity: "low" });
  await addTimer(context.db);
  const result = await applyTriage(context, "s1", false);
  const states = Object.fromEntries((await context.db.select().from(schema.alertIssues).all()).map((r) => [r.issueId, r.state]));
  assert.deepEqual(states, { a: "closed", b: "watching", c: "left_open", d: "nr_closed", e: "left_open" });
  assert.deepEqual([acked, resolved], [[], []], "Tracer no longer acts itself");
  assert.equal(result?.ping, true);
  assert.match(result!.action, /Acked and closed in New Relic: Errors\. Why: errors back to 0 since 13:58/);
  assert.match(result!.action, /Left open \(not closed\): Errors/);
});

test("applyTriage pings for a high-severity close the agent made, not for a medium one", async () => {
  const { context } = fakeNewRelic({});
  await addIssue(context.db, "a", { state: "closed", verdict: "stopped", severity: "medium" });
  assert.equal((await applyTriage(context, "s1", false))?.ping, false);
  await context.db.update(schema.alertIssues).set({ severity: "high" }).run();
  assert.equal((await applyTriage(context, "s1", false))?.ping, true);
});

test("applyTriage never closes while the Settings switch is off", async () => {
  const { context, resolved, acked } = fakeNewRelic({ a: "ACTIVATED" }, false);
  await addIssue(context.db, "a", { verdict: "stopped", severity: "low" });
  const result = await applyTriage(context, "s1", false);
  assert.deepEqual(resolved, []);
  assert.deepEqual(acked, []);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "left_open");
  assert.equal(result?.ping, true);
});

test("applyTriage leaves an ongoing issue open and pings when no follow-up timer is set", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a", { verdict: "ongoing", severity: "low" });
  const result = await applyTriage(context, "s1", false);
  const row = await context.db.select().from(schema.alertIssues).get();
  assert.equal(row?.state, "left_open");
  assert.equal(result?.ping, true);
  assert.match(result!.action, /Left open \(no re-check set\): Errors/);
});

test("a follow-up wake-up gives the close tool for its issues; the agent closes and the re-check reports it", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a", { state: "watching", verdict: "ongoing", severity: "low", watchUntil: Math.floor(Date.now() / 1000) + 3600 });
  const extras = await wakeupExtras(context, "s1");
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "pending");
  assert.match(extras.lines.join("\n"), /- a: Errors \| Issue a/);
  assert.deepEqual(Object.keys(extras.tools!).sort(), ["ack_nr_issue", "close_nr_issue", "report_alert_summary", "report_issue_status"]);
  await toolRun(extras.tools!.close_nr_issue, "a");
  const t = extras.tools!.report_issue_status as ReturnType<typeof reportIssueStatusTool>;
  await t.execute!({ severity: "low", issues: [{ issueId: "a", status: "stopped", reason: "errors back to 0 since 13:58" }] }, { toolCallId: "c", messages: [] } as never);
  const result = await applyTriage(context, "s1", true, ["a"]);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "closed");
  assert.deepEqual(resolved, ["a"]);
  assert.match(result!.action, /Acked and closed in New Relic: Errors\. Why: errors back to 0 since 13:58$/);
});

test("a follow-up wake-up stops watching when triage is off or the 24h cap passed", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" }, false);
  await addIssue(context.db, "a", { state: "watching", verdict: "ongoing" });
  assert.equal((await wakeupExtras(context, "s1")).tools?.report_issue_status, undefined);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "left_open");

  const on = fakeNewRelic({ b: "ACTIVATED" });
  await addIssue(on.context.db, "b", { state: "watching", verdict: "ongoing", watchUntil: 1 });
  assert.equal((await wakeupExtras(on.context, "s1")).tools?.report_issue_status, undefined);
  assert.equal((await on.context.db.select().from(schema.alertIssues).get())?.state, "left_open");
});

test("checkWatches deletes finished issues after the retention period and keeps the rest", async () => {
  const { context } = fakeNewRelic({});
  const old = Math.floor(Date.now() / 1000) - CONFIG.triageRetentionSeconds - 60;
  await addIssue(context.db, "a", { state: "closed", updatedAt: old });
  await addIssue(context.db, "b", { state: "left_open", updatedAt: old });
  await addIssue(context.db, "c", { state: "nr_closed" });
  await addIssue(context.db, "d", { state: "watching", updatedAt: old });
  await addTimer(context.db);
  await checkWatches(context);
  assert.deepEqual((await context.db.select().from(schema.alertIssues).all()).map((r) => r.issueId).sort(), ["c", "d"]);
});

test("checkWatches leaves watched issues open once their follow-up timer is gone", async () => {
  const { context } = fakeNewRelic({});
  await addIssue(context.db, "a", { state: "watching", verdict: "ongoing" });
  await checkWatches(context);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "left_open");
});

test("checkWatches orphans only watched issues without a pending timer", async () => {
  const { context } = fakeNewRelic({});
  await context.db.run(sql`INSERT INTO chat_sessions VALUES ('s2', 'Two', '[]', 'idle', 'monitor', NULL, NULL, NULL, NULL, 0, 0, 0)`);
  await context.db.run(sql`INSERT INTO chat_sessions VALUES ('s3', 'Three', '[]', 'idle', 'monitor', NULL, NULL, NULL, NULL, 0, 0, 0)`);
  await addIssue(context.db, "kept", { state: "watching", sessionId: "s1" });
  await addIssue(context.db, "spent", { state: "watching", sessionId: "s2" });
  await addIssue(context.db, "none", { state: "watching", sessionId: "s3" });
  await addTimer(context.db, "s1");
  await context.db.insert(schema.sessionTimers).values({ sessionId: "s2", fireAt: null, note: "n", setAt: 0 }).run();
  await checkWatches(context);
  const states = Object.fromEntries((await context.db.select().from(schema.alertIssues).all()).map((r) => [r.issueId, r.state]));
  assert.deepEqual(states, { kept: "watching", spent: "left_open", none: "left_open" });
});

async function withSlack(db: Db, fn: (posts: string[]) => Promise<void>) {
  await writeSlackConfig(db, { webhookUrl: "https://hooks.slack.com/services/T/B/x" });
  const posts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    posts.push(init.body as string);
    return new Response("ok");
  }) as typeof fetch;
  try {
    await fn(posts);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function settle(until: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100 && !(await until()); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
}

const reported = async (db: Db) => (await db.select({ r: schema.monitorTriggers.reported }).from(schema.monitorTriggers).get())?.r;

test("a retried firing gets report_issue_status for its pending issues, triages and posts once", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a");
  await withSlack(context.db, async (posts) => {
    const rerun = (await firingRerun(context, "s1"))!;
    assert.ok(rerun.tools.report_alert_summary);
    await toolRun(rerun.tools.close_nr_issue, "a");
    const t = rerun.tools.report_issue_status as ReturnType<typeof reportIssueStatusTool>;
    await t.execute!({ severity: "low", issues: [{ issueId: "a", status: "stopped", reason: "errors back to 0 since 13:58" }] }, { toolCallId: "c", messages: [] } as never);
    rerun.onComplete({});
    rerun.onComplete({});
    await settle(() => posts.length > 0);
    assert.deepEqual(resolved, ["a"]);
    assert.equal(posts.length, 1);
    assert.equal(await reported(context.db), "done");
    assert.equal((await firingRerun(context, "s1")), null, "a reported firing is a plain chat");
  });
});

test("a retried incident firing with no open issue can be dismissed, and a dismissed run posts nothing", async () => {
  const { context } = fakeNewRelic({});
  await context.db.update(schema.monitors).set({ query: MONITOR_QUERY }).run();
  const dismissal = { type: "tool-dismiss_alert", toolCallId: "d", state: "output-available", input: { reason: "incident 1 closed at 13:58" }, output: { recorded: true } };
  await context.db.update(schema.chatSessions).set({ messages: JSON.stringify([{ id: "", role: "assistant", parts: [dismissal] }]) }).run();
  await withSlack(context.db, async (posts) => {
    const rerun = (await firingRerun(context, "s1"))!;
    assert.ok(rerun.tools.dismiss_alert);
    assert.equal(rerun.tools.report_issue_status, undefined);
    assert.equal(rerun.tools.close_nr_issue, undefined);
    assert.equal(rerun.tools.ack_nr_issue, undefined);
    rerun.onComplete({});
    await settle(() => false);
    assert.equal(posts.length, 0);
    assert.equal(await reported(context.db), "done");
  });
});

test("closedCheckPrompt asks to check the incident state and states what Tracer already found", () => {
  const text = closedCheckPrompt({ open: [], closed: [{ issueId: "a" } as AiIssue], tracked: 2 }, true).join("\n");
  assert.match(text, /First check that this alert is still open/);
  assert.match(text, /1 already closed, 2 handled by an earlier alert/);
  assert.match(text, /call dismiss_alert alone/);
  assert.doesNotMatch(closedCheckPrompt(null, true).join("\n"), /Tracer found/);
  assert.doesNotMatch(closedCheckPrompt(null, false).join("\n"), /Slack/);
});

test("a firing whose every attempt failed posts once and keeps its issues for a Retry, which acks and closes", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a", { verdict: "stopped", severity: "low" });
  await withSlack(context.db, async (posts) => {
    const first = (await firingRerun(context, "s1"))!;
    first.onComplete({ error: "Overloaded" });
    first.onComplete({ error: "Overloaded" });
    await settle(() => posts.length > 0);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /Investigation failed\. Issues it did not close stay open\./);
    const row = await context.db.select().from(schema.alertIssues).get();
    assert.equal(row?.state, "pending");
    assert.equal(row?.verdict, null, "a failed run's report is not trusted");
    assert.deepEqual(resolved, []);
    assert.equal(await reported(context.db), "failed");

    const retry = (await firingRerun(context, "s1"))!;
    retry.onComplete({ error: "Overloaded" });
    await settle(() => false);
    assert.equal(posts.length, 1, "a repeated failure is not posted again");
    await toolRun(retry.tools.close_nr_issue, "a");
    const t = retry.tools.report_issue_status as ReturnType<typeof reportIssueStatusTool>;
    await t.execute!({ severity: "low", issues: [{ issueId: "a", status: "stopped", reason: "errors back to 0 since 13:58" }] }, { toolCallId: "c", messages: [] } as never);
    retry.onComplete({});
    await settle(() => posts.length > 1);
    assert.equal(posts.length, 2);
    assert.match(posts[1], /Acked and closed in New Relic/);
    assert.deepEqual(resolved, ["a"]);
    assert.equal(await reported(context.db), "done");
  });
});

test("a failed follow-up run keeps its issues watched and, when the alert was ongoing, sets another check", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED" });
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds() }).run();
  await report(context.db, { severity: "low", state: "ongoing" });
  await addIssue(context.db, "a", { state: "watching", verdict: "ongoing", severity: "low", watchUntil: nowSeconds() + 3600 });
  const extras = await wakeupExtras(context, "s1");
  const t = extras.tools!.report_issue_status as ReturnType<typeof reportIssueStatusTool>;
  await t.execute!({ severity: "low", issues: [{ issueId: "a", status: "stopped", reason: "errors back to 0 since 13:58" }] }, { toolCallId: "c", messages: [] } as never);
  await withSlack(context.db, async (posts) => {
    await writeSlackConfig(context.db, { webhookUrl: "https://hooks.slack.com/services/T/B/x", mentions: "@here" });
    extras.onComplete!({ error: "Overloaded" });
    await settle(async () => !!await timerOf(context.db));
    assert.equal(posts.length, 0);
  });
  const row = (await context.db.select().from(schema.alertIssues).get())!;
  assert.equal(row.state, "watching");
  assert.equal(row.verdict, null);
  assert.deepEqual(resolved, []);
});

const issueList = [{ issueId: "a", conditionName: ["Errors"], title: ["Issue a"] } as unknown as AiIssue];
const monitorRow = { name: "M", provider: "newrelic", query: "q", condition: "> 0" } as typeof schema.monitors.$inferSelect;
const groups = [{ key: "", count: 3, sessionId: null, repeat: false }];
const fields = (t: unknown) => Object.keys((t as { inputSchema: { shape: object } }).inputSchema.shape);
const call = (input: object) => ({ type: "tool-report_alert_summary", toolCallId: "r", state: "output-available", input, output: { recorded: true } });
const report = (db: Db, input: object) =>
  db.update(schema.chatSessions).set({ messages: JSON.stringify([{ id: "", role: "assistant", parts: [call(input)] }]) }).run();
const SLACK_REPORT = { severity: "high", state: "ongoing", policy: "p", started: "s", status: "ongoing", issues: [] };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const timerOf = (db: Db) => db.select().from(schema.sessionTimers).get();

test("without Slack the firing has the alert report with no Slack fields, and no prompt names Slack", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a");
  const tool = (await firingRerun(context, "s1"))!.tools.report_alert_summary as { description: string };
  assert.deepEqual(fields(tool), ["severity", "state"]);
  assert.doesNotMatch(tool.description, /Slack/);
  const text = buildMessage(monitorRow, 3, { start: 0, end: 60 }, groups, [], issuesPrompt(issueList, new Map()), false, false);
  assert.doesNotMatch(text, /Slack/);
  assert.ok(text.includes(MONITOR_ROLE));
  assert.match(text, /call report_alert_summary once with the severity and the state/);
  await withSlack(context.db, async () => {
    const withFields = (await firingRerun(context, "s1"))!.tools.report_alert_summary as { description: string };
    assert.deepEqual(fields(withFields), ["severity", "state", "policy", "started", "status", "issues", "notify"]);
    assert.match(withFields.description, /Slack/);
    assert.match(buildMessage(monitorRow, 3, { start: 0, end: 60 }, groups, [], [], false, true), /Slack posts the card/);
  });
});

test("a wake-up of a monitor session without watched issues gets the role, the alert report and nothing else", async () => {
  const { context } = fakeNewRelic({});
  const extras = await wakeupExtras(context, "s1");
  assert.ok(extras.lines.includes(MONITOR_ROLE));
  assert.deepEqual(Object.keys(extras.tools!), ["report_alert_summary"]);
  assert.deepEqual(fields(extras.tools!.report_alert_summary), ["severity", "state"]);
  assert.doesNotMatch(extras.lines.join("\n"), /Slack/);
  assert.deepEqual(await wakeupExtras(context, "other"), { lines: [] }, "a session with no firing is a plain chat");
});

test("a due timer wakes a monitor session with its provider scope and kind", async () => {
  const { context } = fakeNewRelic({});
  await context.db.update(schema.chatSessions).set({ runScope: "newrelic" }).run();
  await addTimer(context.db);
  await context.db.update(schema.sessionTimers).set({ fireAt: 1 }).run();
  const started: StartSessionOptions[] = [];
  await fireDueTimers(context, async (_c, options) => { started.push(options); return { ok: true }; });
  assert.equal(started[0].provider, "newrelic");
  assert.equal(started[0].kind, "monitor");
  assert.ok(started[0].tools?.report_alert_summary);
  assert.ok(started[0].message.includes(MONITOR_ROLE));
});

for (const notify of [true, false]) {
  test(`a completed wake-up posts the re-check ${notify ? "with" : "without"} a ping when notify is ${notify}`, async () => {
    const { context } = fakeNewRelic({});
    await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds() }).run();
    await report(context.db, { ...SLACK_REPORT, notify });
    await withSlack(context.db, async (posts) => {
      await writeSlackConfig(context.db, { webhookUrl: "https://hooks.slack.com/services/T/B/x", mentions: "@here" });
      (await wakeupExtras(context, "s1")).onComplete!({});
      await settle(() => posts.length > 0);
      assert.equal(posts.length, 1);
      assert.match(posts[0], /\*M\*/);
      assert.match(posts[0], /State: ongoing\./);
      assert.equal(posts[0].includes("<!here>"), notify);
    });
  });
}

test("a completed wake-up posts nothing without Slack, and a failed one posts nothing extra", async () => {
  const { context } = fakeNewRelic({});
  await report(context.db, { severity: "high", state: "resolved" });
  const realFetch = globalThis.fetch;
  let posted = 0;
  globalThis.fetch = (async () => { posted++; return new Response("ok"); }) as typeof fetch;
  try {
    const extras = await wakeupExtras(context, "s1");
    extras.onComplete!({});
    extras.onComplete!({ error: "Overloaded" });
    await settle(() => false);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(posted, 0);
});

test("an ongoing report without a timer gets one at the follow-up interval; a set timer stays", async () => {
  const { context } = fakeNewRelic({});
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds() }).run();
  await report(context.db, { severity: "low", state: "ongoing" });
  (await wakeupExtras(context, "s1")).onComplete!({});
  await settle(async () => !!await timerOf(context.db));
  const due = (await timerOf(context.db))!.fireAt!;
  assert.ok(Math.abs(due - nowSeconds() - CONFIG.timerFollowUpMinutes * 60) < 5);

  await context.db.update(schema.sessionTimers).set({ fireAt: nowSeconds() + 3000 }).run();
  (await wakeupExtras(context, "s1")).onComplete!({});
  await settle(() => false);
  assert.ok(Math.abs((await timerOf(context.db))!.fireAt! - nowSeconds() - 3000) < 5);

  await context.db.delete(schema.sessionTimers).run();
  await report(context.db, { severity: "low", state: "resolved" });
  (await wakeupExtras(context, "s1")).onComplete!({});
  await settle(() => false);
  assert.equal(await timerOf(context.db), undefined);
});

test("after 24h no timer is set and one final line with a ping is posted", async () => {
  const { context } = fakeNewRelic({});
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds() - CONFIG.triageWatchMaxSeconds - 60 }).run();
  await report(context.db, { ...SLACK_REPORT, notify: false });
  await addTimer(context.db);
  await withSlack(context.db, async (posts) => {
    await writeSlackConfig(context.db, { webhookUrl: "https://hooks.slack.com/services/T/B/x", mentions: "@here" });
    (await wakeupExtras(context, "s1")).onComplete!({});
    await settle(() => posts.length > 1);
    assert.equal(posts.length, 2);
    assert.match(posts[1], /Still ongoing after 24h\. Re-checks stopped\./);
    assert.ok(posts[1].includes("<!here>"));
    assert.equal(await timerOf(context.db), undefined);
  });
});

for (const notify of [true, false]) {
  test(`the firing ping follows notify (${notify})`, async () => {
    const { context } = fakeNewRelic({});
    await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds() }).run();
    await report(context.db, { ...SLACK_REPORT, state: "resolved", notify });
    await withSlack(context.db, async (posts) => {
      await writeSlackConfig(context.db, { webhookUrl: "https://hooks.slack.com/services/T/B/x", mentions: "@here" });
      (await firingRerun(context, "s1"))!.onComplete({});
      await settle(() => posts.length > 0);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].includes("<!here>"), notify);
    });
  });
}

const text = (role: "user" | "assistant", t: string) => ({ id: "", role, parts: [{ type: "text", text: t }] });
const setMessages = (db: Db, messages: unknown[]) => db.update(schema.chatSessions).set({ messages: JSON.stringify(messages) }).run();

test("the watch sweep leaves only the rows of firings that ran on this device", async () => {
  const { context } = fakeNewRelic({});
  const { db } = context;
  await db.run(sql`INSERT INTO monitor_triggers (id, monitor_id, triggered_at, window_start, session_id, device_id) VALUES ('t2', 'm1', 0, 0, 's2', 'other')`);
  await addIssue(db, "mine", { state: "watching", watchUntil: nowSeconds() + 3600 });
  await addIssue(db, "theirs", { state: "watching", sessionId: "s2", triggerId: "t2", watchUntil: nowSeconds() + 3600 });
  await checkWatches(context);
  const states = Object.fromEntries((await db.select().from(schema.alertIssues).all()).map((r) => [r.issueId, r.state]));
  assert.deepEqual(states, { mine: "left_open", theirs: "watching" });
});

test("a paused monitor or one with alerts off keeps no follow-up timer", async () => {
  for (const off of [{ enabled: 0 }, { alertEnabled: 0 }]) {
    const { context } = fakeNewRelic({});
    await context.db.update(schema.monitors).set(off).run();
    await addTimer(context.db);
    assert.equal(await ensureFollowUp(context, "s1", { severity: "low", state: "ongoing" }), false);
    assert.equal(await timerOf(context.db), undefined);

    await addTimer(context.db);
    await context.db.update(schema.sessionTimers).set({ fireAt: 1 }).run();
    const started: StartSessionOptions[] = [];
    await fireDueTimers(context, async (_c, options) => { started.push(options); return { ok: true }; });
    assert.deepEqual(started, []);
    assert.equal(await timerOf(context.db), undefined);
  }
});

test("turning a monitor or its alerts off clears the timers of its sessions", async () => {
  for (const toggles of [{ run: false }, { alert: false }]) {
    const { context } = fakeNewRelic({});
    await addTimer(context.db);
    await setMonitorToggles(context.db, "m1", toggles);
    assert.equal(await timerOf(context.db), undefined);
  }
  const { context } = fakeNewRelic({});
  await addTimer(context.db);
  await setMonitorToggles(context.db, "m1", { run: true, alert: true });
  assert.ok(await timerOf(context.db));
});

test("a wake-up with no connected provider is not run and is retried later", async () => {
  const { context } = fakeNewRelic({});
  const offline = { ...context, providers: { getAllProviders: () => [] } as unknown as ProviderRegistry };
  await addTimer(context.db);
  await context.db.update(schema.sessionTimers).set({ fireAt: 1, setAt: nowSeconds() - 600 }).run();
  const started: StartSessionOptions[] = [];
  await fireDueTimers(offline, async (_c, options) => { started.push(options); return { ok: true }; });
  assert.deepEqual(started, []);
  assert.ok((await timerOf(context.db))!.fireAt! > nowSeconds());
});

test("a wake-up that cannot start is dropped 24h after the timer was set", async () => {
  const { context } = fakeNewRelic({});
  await addTimer(context.db);
  await context.db.update(schema.sessionTimers).set({ fireAt: 1, setAt: nowSeconds() - CONFIG.timerMaxAfterSessionSeconds - 1 }).run();
  await fireDueTimers(context, async () => ({ error: "no model" }));
  assert.equal(await timerOf(context.db), undefined);
});

test("only the latest run's report sets the next check and the re-check state", async () => {
  const { context } = fakeNewRelic({});
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds() }).run();
  await setMessages(context.db, [
    text("user", "Monitor triggered"),
    { id: "", role: "assistant", parts: [call({ severity: "high", state: "ongoing" })] },
    text("user", "Follow-up timer (set)"),
    text("assistant", "I could not tell."),
  ]);
  await withSlack(context.db, async (posts) => {
    await writeSlackConfig(context.db, { webhookUrl: "https://hooks.slack.com/services/T/B/x", mentions: "@here" });
    (await wakeupExtras(context, "s1")).onComplete!({});
    await settle(() => posts.length > 0);
    assert.equal(await timerOf(context.db), undefined, "an older ongoing report forces no timer");
    assert.doesNotMatch(posts[0], /State:/);
    assert.equal(posts[0].includes("<!here>"), false);
  });
});

test("the issue watch limit counts from the firing", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" });
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: 1_000_000 }).run();
  await addIssue(context.db, "a", { verdict: "ongoing", severity: "low" });
  await addTimer(context.db);
  await applyTriage(context, "s1", false);
  assert.equal((await context.db.select().from(schema.alertIssues).get())?.watchUntil, 1_000_000 + CONFIG.triageWatchMaxSeconds);
});

test("when the 24h end, exactly one final line is posted and the watch sweep adds none", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" });
  const fired = nowSeconds() - CONFIG.triageWatchMaxSeconds - 60;
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: fired }).run();
  await report(context.db, { ...SLACK_REPORT, notify: false });
  await addIssue(context.db, "a", { state: "watching", verdict: "ongoing", watchUntil: fired + CONFIG.triageWatchMaxSeconds });
  await addTimer(context.db);
  await withSlack(context.db, async (posts) => {
    await writeSlackConfig(context.db, { webhookUrl: "https://hooks.slack.com/services/T/B/x", mentions: "@here" });
    (await wakeupExtras(context, "s1")).onComplete!({});
    await settle(() => posts.length > 1);
    await checkWatches(context);
    await settle(() => false);
    assert.equal(posts.filter((p) => /Still ongoing after 24h\. Re-checks stopped\./.test(p)).length, 1);
    assert.equal(posts.length, 2, "the re-check and the final line");
    assert.equal((await context.db.select().from(schema.alertIssues).get())?.state, "left_open");
  });
});

test("an interrupted firing that never reported posts one Investigation failed line", async () => {
  const { context } = fakeNewRelic({});
  await withSlack(context.db, async (posts) => {
    await settleMonitorRun(context, "s1", "Interrupted by a restart");
    await settleMonitorRun(context, "s1", "Interrupted by a restart");
    assert.equal(posts.length, 1);
    assert.match(posts[0], /Investigation failed/);
    assert.equal(await reported(context.db), "failed");
  });
});

test("an interrupted wake-up keeps the re-check chain", async () => {
  const { context } = fakeNewRelic({});
  await context.db.update(schema.monitorTriggers).set({ triggeredAt: nowSeconds(), reported: "done" }).run();
  await setMessages(context.db, [
    text("user", "Monitor triggered"),
    { id: "", role: "assistant", parts: [call({ severity: "high", state: "ongoing" })] },
    text("user", "Follow-up timer (set 10:00, due 10:05, now 10:06): check. Check it now."),
  ]);
  await settleMonitorRun(context, "s1", "Interrupted by a restart");
  assert.ok(await timerOf(context.db));
});

test("a completed run acks the issues still open and unacked in New Relic when triage is on", async () => {
  const { context, acked } = fakeNewRelic({ a: "ACTIVATED", b: "CLOSED", c: "ACTIVATED" });
  for (const id of ["a", "b", "c"]) await addIssue(context.db, id);
  const provider = context.providers.getProvider("newrelic") as NewRelicProvider;
  const list = provider.aiIssues;
  provider.aiIssues = async (...args) => (await list.apply(provider, args)).map((i) => (i.issueId === "c" ? { ...i, acknowledgedAt: 1 } : i));
  await withSlack(context.db, async (posts) => {
    (await firingRerun(context, "s1"))!.onComplete({});
    await settle(() => posts.length > 0);
    assert.deepEqual(acked, ["a"]);
  });
});

test("a completed run acks nothing when triage is off", async () => {
  const { context, acked } = fakeNewRelic({ a: "ACTIVATED" }, false);
  await addIssue(context.db, "a");
  await withSlack(context.db, async (posts) => {
    (await firingRerun(context, "s1"))!.onComplete({});
    await settle(() => posts.length > 0);
    assert.deepEqual(acked, []);
  });
});

test("a failed run acks nothing", async () => {
  const { context, acked } = fakeNewRelic({ a: "ACTIVATED" });
  await addIssue(context.db, "a");
  await withSlack(context.db, async (posts) => {
    (await firingRerun(context, "s1"))!.onComplete({ error: "Overloaded" });
    await settle(() => posts.length > 0);
    assert.deepEqual(acked, []);
  });
});

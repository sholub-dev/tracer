import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { Db } from "../db/client.js";
import type { Context } from "../trpc/context.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { CONFIG } from "../config.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import type { AiIssue } from "../providers/newrelic/nerdgraph.client.js";
import { applyTriage, checkWatches, decide, incidentQuery, incidentRefs, recheckMessage, reportIssueStatusTool, type DecideInput } from "./triage.js";

const MONITOR_QUERY = "SELECT count(*) FROM NrAiIncident WHERE event = 'open' AND policyName LIKE '%foundations%' FACET conditionName LIMIT 100 SINCE {{SINCE}} UNTIL {{UNTIL}}";

function memoryDb(globalOn = true): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE monitors (id TEXT PRIMARY KEY);
    CREATE TABLE monitor_triggers (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE alert_issues (
      issue_id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, trigger_id TEXT NOT NULL, session_id TEXT NOT NULL,
      condition_name TEXT NOT NULL, title TEXT NOT NULL, severity TEXT, verdict TEXT, state TEXT NOT NULL, last_error TEXT,
      watch_until INTEGER, next_check_at INTEGER, recheck_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO monitor_triggers VALUES ('t1', 0);
  `);
  sqlite.exec("INSERT INTO monitors VALUES ('m1')");
  if (globalOn) sqlite.prepare("INSERT INTO app_settings VALUES ('alert_triage', 'true', 0)").run();
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function addIssue(db: Db, issueId: string, fields: Partial<typeof schema.alertIssues.$inferInsert> = {}) {
  db.insert(schema.alertIssues).values({
    issueId, monitorId: "m1", triggerId: "t1", sessionId: "s1", conditionName: "Errors", title: `Issue ${issueId}`,
    state: "pending", createdAt: 0, updatedAt: Math.floor(Date.now() / 1000), ...fields,
  }).run();
}

function fakeNewRelic(states: Record<string, AiIssue["state"]>, globalOn = true) {
  const provider = new NewRelicProvider({ type: "newrelic", apiKey: "x", accountId: "1" });
  provider.connected = true;
  const resolved: string[] = [];
  const acked: string[] = [];
  provider.ackIssue = async (id) => { acked.push(id); return { ok: true }; };
  provider.aiIssues = async (filter) => (filter.ids ?? []).filter((id) => states[id]).map((id) => ({ issueId: id, state: states[id] }) as AiIssue);
  provider.resolveIssue = async (id) => { resolved.push(id); return { ok: true }; };
  const context = { db: memoryDb(globalOn), providers: { getProvider: () => provider } as unknown as ProviderRegistry, activeStreams: new Map() } as Context;
  return { context, resolved, acked };
}

const base: DecideInput = { verdict: "stopped", severity: "low", nrState: "open", recentCloses: 0, watchExpired: false, recheck: false };

test("decide follows the triage rules", () => {
  assert.deepEqual(decide(base), { outcome: "close", ping: false });
  assert.deepEqual(decide({ ...base, severity: "medium" }), { outcome: "close", ping: false });
  assert.deepEqual(decide({ ...base, severity: "high" }), { outcome: "close", ping: true });
  assert.deepEqual(decide({ ...base, severity: "critical", recheck: true }), { outcome: "close", ping: false });
  assert.deepEqual(decide({ ...base, verdict: "ongoing" }), { outcome: "watching", ping: true });
  assert.deepEqual(decide({ ...base, verdict: "recurring", recheck: true }), { outcome: "watching", ping: false });
  assert.equal(decide({ ...base, verdict: "ongoing", watchExpired: true }).outcome, "left_open");
  assert.equal(decide({ ...base, verdict: "ongoing", watchExpired: true }).ping, true);
  assert.equal(decide({ ...base, verdict: "unknown" }).outcome, "left_open");
  assert.deepEqual(decide({ ...base, nrState: "closed", verdict: "ongoing" }), { outcome: "nr_closed", ping: false });
  assert.equal(decide({ ...base, nrState: "unknown" }).outcome, "left_open");
  assert.equal(decide({ ...base, recentCloses: 3 }).outcome, "left_open");
  assert.equal(decide({ ...base, recentCloses: 3 }).ping, true);
  assert.equal(decide({ ...base, recentCloses: 2 }).outcome, "close");
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
  addIssue(db, "a");
  const t = reportIssueStatusTool(db, ["a"]);
  const run = (input: Parameters<NonNullable<typeof t.execute>>[0]) => t.execute!(input, { toolCallId: "c", messages: [] } as never);
  assert.ok("error" in (await run({ severity: "low", issues: [{ issueId: "a", status: "stopped" }, { issueId: "zzz", status: "stopped" }] }) as object));
  assert.equal(db.select().from(schema.alertIssues).get()?.verdict, null);
  assert.deepEqual(await run({ severity: "high", issues: [{ issueId: "a", status: "ongoing" }] }), { recorded: 1 });
  const row = db.select().from(schema.alertIssues).get();
  assert.equal(row?.verdict, "ongoing");
  assert.equal(row?.severity, "high");
});

test("applyTriage: stopped is acked then closed, ongoing is watched, skipped report is unknown", async () => {
  const { context, resolved, acked } = fakeNewRelic({ a: "ACTIVATED", b: "ACTIVATED", c: "ACTIVATED", d: "CLOSED" });
  addIssue(context.db, "a", { verdict: "stopped", severity: "low" });
  addIssue(context.db, "b", { verdict: "ongoing", severity: "low" });
  addIssue(context.db, "c");
  addIssue(context.db, "d", { verdict: "stopped", severity: "low" });
  const result = await applyTriage(context, "s1", false);
  const states = Object.fromEntries(context.db.select().from(schema.alertIssues).all().map((r) => [r.issueId, r.state]));
  assert.deepEqual(states, { a: "closed", b: "watching", c: "left_open", d: "nr_closed" });
  assert.deepEqual(acked, ["a"]);
  assert.deepEqual(resolved, ["a"]);
  assert.equal(result?.ping, true);
  assert.match(result!.action, /Acked and closed in New Relic: Issue a/);
});

test("applyTriage counts earlier firings, not sibling issues, toward the close loop limit", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED", b: "ACTIVATED", c: "ACTIVATED", d: "ACTIVATED", e: "ACTIVATED" });
  for (const id of ["a", "b", "c", "d"]) addIssue(context.db, id, { verdict: "stopped", severity: "low" });
  await applyTriage(context, "s1", false);
  assert.deepEqual(resolved, ["a", "b", "c", "d"]);
  addIssue(context.db, "e", { sessionId: "s2", verdict: "stopped", severity: "low" });
  await applyTriage(context, "s2", false);
  assert.deepEqual(resolved, ["a", "b", "c", "d", "e"]);
});

test("applyTriage never closes while the Settings switch is off", async () => {
  const { context, resolved, acked } = fakeNewRelic({ a: "ACTIVATED" }, false);
  addIssue(context.db, "a", { verdict: "stopped", severity: "low" });
  const result = await applyTriage(context, "s1", false);
  assert.deepEqual(resolved, []);
  assert.deepEqual(acked, []);
  assert.equal(context.db.select().from(schema.alertIssues).get()?.state, "left_open");
  assert.equal(result?.ping, true);
});

test("a re-check in its own session records against the original firing's rows by issue id", async () => {
  const { context, resolved } = fakeNewRelic({ a: "ACTIVATED", b: "ACTIVATED" });
  addIssue(context.db, "a", { recheckSessionId: "r1" });
  addIssue(context.db, "b", { state: "watching", verdict: "ongoing", severity: "low" });
  const t = reportIssueStatusTool(context.db, ["a"]);
  assert.deepEqual(await t.execute!({ severity: "low", issues: [{ issueId: "a", status: "stopped" }] }, { toolCallId: "c", messages: [] } as never), { recorded: 1 });
  const result = await applyTriage(context, "s1", true);
  const rows = Object.fromEntries(context.db.select().from(schema.alertIssues).all().map((r) => [r.issueId, r]));
  assert.equal(rows.a.sessionId, "s1");
  assert.equal(rows.a.state, "closed");
  assert.equal(rows.b.state, "watching");
  assert.deepEqual(resolved, ["a"]);
  assert.match(result!.action, /Acked and closed in New Relic: Issue a/);
});

test("recheckMessage carries the original finding only when there is one", () => {
  const rows = [{ issueId: "a", conditionName: "Errors", title: "Issue a" }] as Parameters<typeof recheckMessage>[1];
  assert.match(recheckMessage("M", rows, 0, "DB timeouts on /pay"), /Original finding: DB timeouts on \/pay/);
  assert.doesNotMatch(recheckMessage("M", rows, 0, ""), /Original finding/);
});

test("checkWatches deletes finished issues after the retention period and keeps the rest", async () => {
  const { context } = fakeNewRelic({});
  const old = Math.floor(Date.now() / 1000) - CONFIG.triageRetentionSeconds - 60;
  addIssue(context.db, "a", { state: "closed", updatedAt: old });
  addIssue(context.db, "b", { state: "left_open", updatedAt: old });
  addIssue(context.db, "c", { state: "nr_closed" });
  addIssue(context.db, "d", { state: "watching", updatedAt: old, nextCheckAt: null });
  await checkWatches(context);
  assert.deepEqual(context.db.select().from(schema.alertIssues).all().map((r) => r.issueId).sort(), ["c", "d"]);
});

test("a re-check that fails to start deletes its session and retries later", async () => {
  const { context } = fakeNewRelic({ a: "ACTIVATED" });
  (context.db as unknown as { $client: Database.Database }).$client.exec(`
    DROP TABLE monitors;
    CREATE TABLE monitors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, query TEXT NOT NULL, chart_query TEXT, condition TEXT NOT NULL,
      frequency_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL, last_checked_at INTEGER, last_status TEXT NOT NULL, last_error TEXT,
      sort_order INTEGER, card_width INTEGER, alert_enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO monitors VALUES ('m1', 'M', 'newrelic', 'q', NULL, 'c', 60, 1, NULL, 'ok', NULL, NULL, NULL, 1, 0, 0);
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, status TEXT NOT NULL, kind TEXT,
      summary TEXT, summary_up_to INTEGER, summary_created_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO chat_sessions VALUES ('s1', 'Firing', '[]', 'idle', 'monitor', NULL, NULL, NULL, 0, 0);
    INSERT INTO app_settings VALUES ('chat_model', '{"provider":"none","modelId":"x"}', 0);
  `);
  addIssue(context.db, "a", { state: "watching", verdict: "ongoing", nextCheckAt: 0 });
  await checkWatches(context);
  assert.deepEqual(context.db.select({ id: schema.chatSessions.id }).from(schema.chatSessions).all(), [{ id: "s1" }]);
  const row = context.db.select().from(schema.alertIssues).get();
  assert.equal(row?.state, "watching");
  assert.equal(row?.recheckSessionId, null);
  assert.ok((row?.nextCheckAt ?? 0) > 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { eq } from "drizzle-orm";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { writeAppSetting } from "../db/config-reader.js";
import { alertIssues, monitors, monitorTriggers } from "../db/schema.js";
import { SETTINGS_KEYS } from "../config.js";
import type { Context } from "../trpc/context.js";
import type { StartSessionOptions } from "../agents/start-session.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import type { AiIssue } from "../providers/newrelic/nerdgraph.client.js";
import { recordIssues, reportIssueStatusTool } from "./triage.js";
import { runDueMonitors, runMonitorsNow } from "./scheduler.js";

const QUERY = "SELECT count(*) FROM NrAiIncident WHERE event = 'open' FACET conditionName SINCE {{SINCE}} UNTIL {{UNTIL}}";
const now = () => Math.floor(Date.now() / 1000);

const issue = (id: string, state = "ACTIVATED") =>
  ({ issueId: id, state, incidentIds: ["inc1"], title: [`Title ${id}`], conditionName: ["Errors"] }) as AiIssue;

async function env(issues: AiIssue[], { triage = true, query = QUERY }: { triage?: boolean; query?: string } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  await db.insert(monitors).values({ id: "m1", name: "M", provider: "newrelic", query, condition: "> 0", frequencySeconds: 300 }).run();
  if (triage) await writeAppSetting(db, SETTINGS_KEYS.alertTriage, true);
  const provider = new NewRelicProvider({ type: "newrelic", apiKey: "x", accountId: "1" });
  provider.connected = true;
  provider.executeRawQuery = async () => [{ facet: "c", count: 2, "uniques.incidentId": ["inc1"], "uniques.policyId": [7], "uniques.conditionId": [1] }];
  provider.aiIssues = async () => issues;
  const providers = { whenLoaded: async () => {}, reconnectDisconnected: async () => {}, getProvider: () => provider, getAllProviders: () => [provider] };
  const context = { db, providers, activeStreams: new Map() } as unknown as Context;
  const started: StartSessionOptions[] = [];
  const run = (result: { ok: true } | { error: string } = { ok: true }) =>
    runDueMonitors(context, async (_c, options) => { started.push(options); return result; });
  // The other device's earlier firing, as sync delivers it.
  const syncedFiring = async (fields: Partial<typeof monitorTriggers.$inferInsert> = {}) => {
    await db.insert(monitorTriggers).values({
      id: "t0", monitorId: "m1", triggeredAt: now(), value: 2, windowStart: 0, windowEnd: 0, status: "investigating", groups: "[]",
      sessionId: "s0", deviceId: "other-device", ...fields,
    }).run();
  };
  return { db, context, started, run, syncedFiring };
}

test("a firing whose open issues are all known starts no session and is recorded as handled", async () => {
  const { db, started, run, syncedFiring } = await env([issue("i1")]);
  await syncedFiring();
  await db.insert(alertIssues).values({ issueId: "i1", monitorId: "m1", triggerId: "t0", sessionId: "s0", conditionName: "Errors", title: "T", state: "watching", createdAt: 0, updatedAt: 0 }).run();
  await run();
  assert.equal(started.length, 0);
  const own = (await db.select().from(monitorTriggers).all()).find((t) => t.id !== "t0")!;
  assert.equal(own.status, "muted");
  assert.equal(own.sessionId, null);
  assert.equal((await db.select().from(monitors).get())!.lastStatus, "triggered");
});

test("an issue acked in New Relic is not new and its firing starts no session", async () => {
  const { started, run } = await env([{ ...issue("i1"), acknowledgedAt: 1, acknowledgedBy: "someone" }]);
  await run();
  assert.equal(started.length, 0);
});

test("a new issue starts a session that gets only that issue", async () => {
  const { db, started, run, syncedFiring } = await env([issue("i1"), issue("i2")]);
  await syncedFiring();
  await db.insert(alertIssues).values({ issueId: "i1", monitorId: "m1", triggerId: "t0", sessionId: "s0", conditionName: "Errors", title: "T", state: "watching", createdAt: 0, updatedAt: 0 }).run();
  await run();
  assert.equal(started.length, 1);
  assert.match(started[0].message, /- i2: /);
  assert.doesNotMatch(started[0].message, /- i1: /);
  assert.ok(started[0].tools?.report_issue_status);
  const mine = await db.select().from(alertIssues).where(eq(alertIssues.sessionId, started[0].sessionId)).all();
  assert.deepEqual(mine.map((r) => r.issueId), ["i2"]);
});

test("a firing without issue data is skipped when the other device fired it a moment ago, and runs otherwise", async () => {
  const skipped = await env([], { triage: false });
  await skipped.syncedFiring();
  await skipped.run();
  assert.equal(skipped.started.length, 0);

  const own = await env([], { triage: false });
  await own.syncedFiring({ deviceId: (await own.db.query.appSettings.findFirst({ where: (t, { eq: is }) => is(t.key, "device_id") }))!.value });
  await own.run();
  assert.equal(own.started.length, 1, "a firing of this device does not suppress the next window");

  const old = await env([], { triage: false });
  await old.syncedFiring({ triggeredAt: now() - 3600 });
  await old.run();
  assert.equal(old.started.length, 1);
});

test("an issue recorded first by another session stays with it; its status and close updates ignore other sessions", async () => {
  const { db, syncedFiring } = await env([]);
  await syncedFiring();
  await db.insert(monitorTriggers).values({ id: "t1", monitorId: "m1", triggeredAt: now(), value: 1, windowStart: 0, windowEnd: 0, status: "investigating", groups: "[]", sessionId: "s1" }).run();
  const found = { open: [issue("i1")], closed: [] };
  assert.deepEqual([...await recordIssues(db, { monitorId: "m1", triggerId: "t0", sessionId: "s0" }, found)], ["i1"]);
  assert.deepEqual([...await recordIssues(db, { monitorId: "m1", triggerId: "t1", sessionId: "s1" }, found)], []);

  const tool = reportIssueStatusTool(db, ["i1"], "s1");
  await tool.execute!({ severity: "high", issues: [{ issueId: "i1", status: "ongoing", reason: "still failing" }] }, { toolCallId: "c", messages: [] } as never);
  assert.equal((await db.select().from(alertIssues).get())!.verdict, null);
});

test("a session that fails to start leaves no alert issue rows", async () => {
  const { db, started, run } = await env([issue("i1")]);
  await run({ error: "no model" });
  assert.equal(started.length, 1);
  assert.deepEqual(await db.select().from(alertIssues).all(), []);
  assert.deepEqual(await db.select().from(monitorTriggers).all(), []);
});

test("the check on open uses a full-period window ending at now minus the lag, skips recent and disabled monitors, and sets lastCheckedAt", async () => {
  const { db, context } = await env([], { query: "SELECT count(*) FROM Transaction FACET name SINCE {{SINCE}} UNTIL {{UNTIL}}", triage: false });
  const queries: string[] = [];
  const provider = context.providers.getProvider("newrelic")!;
  provider.executeRawQuery = async (query: string) => { queries.push(query); return []; };
  const nothing = async () => ({ ok: true as const });
  const t = now();

  await runMonitorsNow(context, nothing);
  assert.equal(queries.length, 1);
  const checked = (await db.select().from(monitors).get())!.lastCheckedAt!;
  assert.ok(Math.abs(checked - (t - 60)) <= 2);
  const stamps = queries[0].match(/\d{10,}/g)!.map(Number);
  assert.equal(stamps.length, 2);
  assert.equal(stamps[1] - stamps[0], 300 * 1000 * 1);

  await runMonitorsNow(context, nothing);
  assert.equal(queries.length, 1, "checked in the last minute");

  await db.update(monitors).set({ lastCheckedAt: t - 200 }).run();
  await runMonitorsNow(context, nothing);
  assert.equal(queries.length, 2);

  await db.update(monitors).set({ lastCheckedAt: t - 600, enabled: 0 }).run();
  await runMonitorsNow(context, nothing);
  assert.equal(queries.length, 2, "disabled");
});

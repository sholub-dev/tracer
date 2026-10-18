import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { eq } from "drizzle-orm";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { writeAppSetting } from "../db/config-reader.js";
import { monitors, monitorTriggers } from "../db/schema.js";
import { CONFIG, SETTINGS_KEYS } from "../config.js";
import type { Context } from "../trpc/context.js";
import type { StartSessionOptions } from "../agents/start-session.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import type { AiIssue } from "../providers/newrelic/nerdgraph.client.js";
import { resolveFiring, runDueMonitors, runMonitorsNow } from "./scheduler.js";

// The tests and the scheduler both read the clock; a 5-minute boundary between those reads would shift the window.
before(() => {
  const midWindow = (Math.floor(Date.now() / 300_000) * 300 + 60 + 150) * 1000;
  mock.timers.enable({ apis: ["Date"], now: midWindow });
});
after(() => mock.timers.reset());

const INCIDENTS = "SELECT count(*) FROM NrAiIncident WHERE event = 'open' FACET conditionName SINCE {{SINCE}} UNTIL {{UNTIL}}";
const TRANSACTIONS = "SELECT count(*) FROM Transaction FACET name SINCE {{SINCE}} UNTIL {{UNTIL}}";
const now = () => Math.floor(Date.now() / 1000);
const openEnd = () => now() - CONFIG.monitorIncidentLagSeconds;
const dueEnd = () => Math.floor(openEnd() / 300) * 300;
const issue = (id: string, state = "ACTIVATED") =>
  ({ issueId: id, state, incidentIds: ["inc1"], title: [`Title ${id}`], conditionName: ["Errors"] }) as AiIssue;

async function env(issues: AiIssue[], { query = INCIDENTS, triage = true, lastCheckedAt }: { query?: string; triage?: boolean; lastCheckedAt: number }) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  await db.insert(monitors).values({ id: "m1", name: "M", provider: "newrelic", query, condition: "> 0", frequencySeconds: 300, lastCheckedAt }).run();
  if (triage) await writeAppSetting(db, SETTINGS_KEYS.alertTriage, true);
  const provider = new NewRelicProvider({ type: "newrelic", apiKey: "x", accountId: "1" });
  provider.connected = true;
  provider.executeRawQuery = async () => [{ facet: "c", count: 2, "uniques.incidentId": ["inc1"], "uniques.policyId": [7], "uniques.conditionId": [1] }];
  provider.aiIssues = async () => issues;
  const providers = { whenLoaded: async () => {}, reconnectDisconnected: async () => {}, getProvider: () => provider, getAllProviders: () => [provider] };
  const context = { db, providers, activeStreams: new Map() } as unknown as Context;
  const started: StartSessionOptions[] = [];
  const start = async (_c: Context, options: StartSessionOptions) => { started.push(options); return { ok: true as const }; };
  const confirmAll = async () => {
    const pending = await db.select({ id: monitorTriggers.id }).from(monitorTriggers).where(eq(monitorTriggers.status, "pending")).all();
    for (const { id } of pending) await resolveFiring(context, id, "start", start);
  };
  return {
    db, started,
    open: async () => { await runMonitorsNow(context, start); await confirmAll(); },
    due: async () => { await runDueMonitors(context, start); await confirmAll(); },
    triggers: () => db.select().from(monitorTriggers).all(),
  };
}

test("an app opened 10 minutes after an incident event checks the time since the last check and fires it", async () => {
  const last = openEnd() - 600;
  const { started, open, triggers } = await env([issue("i1")], { lastCheckedAt: last });
  await open();
  const [row] = await triggers();
  assert.equal(row.windowStart, last);
  assert.equal(row.windowEnd, openEnd());
  assert.equal(started.length, 1);
  assert.match(started[0].message, /- i1: /);
});

test("an app opened after 5 hours checks only the last 4 hours", async () => {
  const { started, open, triggers } = await env([issue("i1")], { lastCheckedAt: openEnd() - 5 * 3600 });
  await open();
  const [row] = await triggers();
  assert.equal(row.windowEnd - row.windowStart, CONFIG.monitorCatchUpSeconds);
  assert.equal(started.length, 1);
});

test("a catch-up window with only closed issues records a closed firing and starts no session", async () => {
  const { started, open, triggers } = await env([issue("i1", "CLOSED")], { lastCheckedAt: openEnd() - 600 });
  await open();
  const rows = await triggers();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "closed");
  assert.equal(rows[0].sessionId, null);
  assert.equal(started.length, 0);
});

test("a catch-up window without issue data still starts a session when an earlier firing overlaps it", async () => {
  const last = openEnd() - 600;
  const { db, started, open } = await env([], { triage: false, lastCheckedAt: last });
  await db.insert(monitorTriggers).values({
    id: "t0", monitorId: "m1", triggeredAt: now() - 60, value: 2, windowStart: openEnd() - 300, windowEnd: openEnd() - 60, status: "investigating", groups: "[]",
    sessionId: "s0", deviceId: "other-device",
  }).run();
  await open();
  assert.equal(started.length, 1);
});

test("a monitor not on NrAiIncident keeps its one-period window on open", async () => {
  const { open, triggers } = await env([], { query: TRANSACTIONS, lastCheckedAt: openEnd() - 3600 });
  await open();
  const [row] = await triggers();
  assert.equal(row.windowEnd - row.windowStart, 300);
});

test("the regular cadence of an incident monitor still checks one period", async () => {
  const { started, due, triggers } = await env([issue("i1")], { lastCheckedAt: dueEnd() - 300 });
  await due();
  const [row] = await triggers();
  assert.equal(row.windowStart, dueEnd() - 300);
  assert.equal(row.windowEnd, dueEnd());
  assert.equal(started.length, 1);
});

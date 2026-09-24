import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { substituteWindow } from "@tracer-sh/shared";
import * as schema from "../db/schema.js";
import type { Db } from "../db/client.js";
import { evaluateCondition, extractGroups, parseCondition, sumGroups } from "./condition.js";
import { classifyGroups } from "./repeats.js";
import { isFailedWindow, nextWindow } from "./scheduler.js";
import { validateMonitor } from "./validate.js";
import { saveMonitor, setMonitorToggles } from "./store.js";
import type { ProviderRegistry } from "../providers/registry.js";

function memoryDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE monitor_triggers (
      id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, triggered_at INTEGER NOT NULL, value REAL NOT NULL,
      window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, status TEXT NOT NULL, groups TEXT NOT NULL, session_id TEXT
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function addTrigger(db: Db, triggeredAt: number, status: "investigating" | "repeat", groups: unknown[], sessionId: string | null) {
  db.insert(schema.monitorTriggers).values({
    id: crypto.randomUUID(), monitorId: "m1", triggeredAt, value: 1, windowStart: 0, windowEnd: 0,
    status, groups: JSON.stringify(groups), sessionId,
  }).run();
}

test("parseCondition accepts operator + number and rejects anything else", () => {
  assert.deepEqual(parseCondition("> 0"), { op: ">", threshold: 0 });
  assert.deepEqual(parseCondition(">=5"), { op: ">=", threshold: 5 });
  assert.deepEqual(parseCondition(" != -1.5 "), { op: "!=", threshold: -1.5 });
  assert.equal(parseCondition("count > 0"), null);
  assert.equal(parseCondition("=> 3"), null);
  assert.equal(parseCondition(""), null);
});

test("evaluateCondition applies each operator", () => {
  const ev = (c: string, v: number) => evaluateCondition(parseCondition(c)!, v);
  assert.equal(ev("> 0", 1), true);
  assert.equal(ev("> 0", 0), false);
  assert.equal(ev(">= 2", 2), true);
  assert.equal(ev("< 2", 2), false);
  assert.equal(ev("<= 2", 2), true);
  assert.equal(ev("== 3", 3), true);
  assert.equal(ev("!= 3", 3), false);
});

test("extractGroups handles no facet, facet string, facet array and nulls", () => {
  assert.deepEqual(extractGroups([{ count: 4 }]), [{ key: "", count: 4 }]);
  assert.deepEqual(
    extractGroups([{ facet: "svc-a", "entity.name": "svc-a", count: 2 }, { facet: "svc-b", "entity.name": "svc-b", count: 3 }]),
    [{ key: "svc-a", count: 2 }, { key: "svc-b", count: 3 }],
  );
  assert.deepEqual(
    extractGroups([{ facet: ["svc-a", 500], appName: "svc-a", httpResponseCode: 500, count: 7 }]),
    [{ key: "svc-a, 500", count: 7 }],
  );
  assert.deepEqual(extractGroups([{ facet: 500, httpResponseCode: 500, count: 500 }]), [{ key: "500", count: 500 }]);
  assert.deepEqual(extractGroups([{ "uniqueCount.x": null }]), [{ key: "", count: 0 }]);
  assert.deepEqual(extractGroups(null), []);
  assert.deepEqual(extractGroups([]), []);
  assert.equal(sumGroups([{ key: "a", count: 2 }, { key: "b", count: 3 }]), 5);
});

test("extractGroups for PostHog joins non-numeric columns as the key and uses the first number as count", () => {
  assert.deepEqual(extractGroups([{ count: 4 }], "posthog"), [{ key: "", count: 4 }]);
  assert.deepEqual(
    extractGroups([{ url: "/a", browser: "Chrome", count: 2 }, { url: "/b", browser: null, count: 3 }], "posthog"),
    [{ key: "/a, Chrome", count: 2 }, { key: "/b, (none)", count: 3 }],
  );
  assert.deepEqual(extractGroups([{ url: "/a" }], "posthog"), [{ key: "/a", count: 0 }]);
  assert.deepEqual(extractGroups(null, "posthog"), []);
  assert.deepEqual(extractGroups([{ url: "/a", count: "12" }], "posthog"), [{ key: "/a", count: 12 }]);
  // PostHog rows have no facet, so NR parsing would lose the group.
  assert.deepEqual(extractGroups([{ url: "/a", count: 2 }]), [{ key: "", count: 2 }]);
});

test("substituteWindow uses epoch seconds for PostHog and epoch ms for New Relic", () => {
  const nrql = "SELECT count(*) FROM Log SINCE {{SINCE}} UNTIL {{UNTIL}}";
  const hogql = "SELECT count() FROM events WHERE timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}})";
  assert.equal(substituteWindow("newrelic", nrql, 1000, 1300), "SELECT count(*) FROM Log SINCE 1000000 UNTIL 1300000");
  assert.equal(
    substituteWindow("posthog", hogql, 1000, 1300),
    "SELECT count() FROM events WHERE timestamp >= toDateTime(1000) AND timestamp < toDateTime(1300)",
  );
});

test("classifyGroups marks all groups repeat when each was investigated in the window", () => {
  const db = memoryDb();
  const now = 1_000_000;
  addTrigger(db, now - 3600, "investigating", [{ key: "a", count: 1, sessionId: "s1", repeat: false }, { key: "b", count: 1, sessionId: "s1", repeat: false }], "s1");
  const out = classifyGroups(db, "m1", [{ key: "a", count: 2 }, { key: "b", count: 5 }], now);
  assert.deepEqual(out, [
    { key: "a", count: 2, sessionId: "s1", repeat: true },
    { key: "b", count: 5, sessionId: "s1", repeat: true },
  ]);
});

test("classifyGroups splits mixed groups and links repeats to the latest investigating session", () => {
  const db = memoryDb();
  const now = 1_000_000;
  addTrigger(db, now - 7200, "investigating", [{ key: "a", count: 1, sessionId: "s1", repeat: false }], "s1");
  addTrigger(db, now - 3600, "investigating", [{ key: "a", count: 1, sessionId: "s2", repeat: false }], "s2");
  addTrigger(db, now - 60, "repeat", [{ key: "c", count: 1, sessionId: "s9", repeat: true }], null);
  const out = classifyGroups(db, "m1", [{ key: "a", count: 1 }, { key: "c", count: 1 }], now);
  assert.deepEqual(out, [
    { key: "a", count: 1, sessionId: "s2", repeat: true },
    { key: "c", count: 1, sessionId: null, repeat: false },
  ]);
});

test("classifyGroups treats triggers outside the repeat window as new", () => {
  const db = memoryDb();
  const now = 1_000_000;
  addTrigger(db, now - 86_401, "investigating", [{ key: "a", count: 1, sessionId: "s1", repeat: false }], "s1");
  const out = classifyGroups(db, "m1", [{ key: "a", count: 1 }], now);
  assert.deepEqual(out, [{ key: "a", count: 1, sessionId: null, repeat: false }]);
});

test("classifyGroups never treats an unfaceted group as a repeat", () => {
  const db = memoryDb();
  const now = 1_000_000;
  addTrigger(db, now - 60, "investigating", [{ key: "", count: 1, sessionId: "s1", repeat: false }], "s1");
  const out = classifyGroups(db, "m1", [{ key: "", count: 1 }], now);
  assert.deepEqual(out, [{ key: "", count: 1, sessionId: null, repeat: false }]);
});

test("nextWindow aligns runs to clock boundaries, applies lag, and never overlaps", () => {
  const lag = 60;
  // 10:47:10 -> the latest 5-min boundary is 10:45:00, window ends at 10:44:00.
  const t = (h: number, m: number, sec = 0) => h * 3600 + m * 60 + sec;
  assert.deepEqual(nextWindow(null, 300, t(10, 47, 10), lag), { start: t(10, 39), end: t(10, 44) });
  assert.equal(nextWindow(t(10, 44), 300, t(10, 49, 59), lag), null);
  assert.deepEqual(nextWindow(t(10, 44), 300, t(10, 50, 5), lag), { start: t(10, 44), end: t(10, 49) });
  // An unaligned end from before this change catches up at the next boundary.
  assert.deepEqual(nextWindow(t(10, 43, 23), 300, t(10, 45, 2), lag), { start: t(10, 43, 23), end: t(10, 44) });
  // After sleep, one window covers the whole gap.
  assert.deepEqual(nextWindow(t(10, 44), 300, t(12, 1), lag), { start: t(10, 44), end: t(11, 59) });
});

test("isFailedWindow skips only the window end that failed", () => {
  const failed = new Map([["m1", 1000]]);
  assert.equal(isFailedWindow(failed, "m1", 1000), true);
  assert.equal(isFailedWindow(failed, "m1", 1300), false);
  assert.equal(isFailedWindow(failed, "m2", 1000), false);
});

test("validateMonitor checks provider-specific rules", async () => {
  const registry = {} as ProviderRegistry;
  const hog = "SELECT count() AS count FROM events WHERE timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}})";
  const base = { query: hog, condition: "> 0", frequencySeconds: 300 };
  const err = async (d: Parameters<typeof validateMonitor>[1]) => {
    const r = await validateMonitor(registry, d);
    return "error" in r ? r.error : null;
  };
  assert.match((await err({ ...base, provider: "gcp" }))!, /Unsupported monitor provider/);
  assert.match((await err({ ...base, provider: "posthog" }))!, /chartQuery/);
  assert.match((await err({ ...base, provider: "posthog", chartQuery: "SELECT 1" }))!, /\{\{SINCE\}\}/);
  assert.equal(await err({ ...base, provider: "posthog", chartQuery: hog }), null);
  assert.match((await err({ ...base, provider: "newrelic", query: "SELECT count(*) FROM Log SINCE {{SINCE}} UNTIL {{UNTIL}} TIMESERIES" }))!, /TIMESERIES/);
});

test("setMonitorToggles changes only the given toggles and resets the window when Run turns on", () => {
  const db = memoryDb();
  db.$client.exec(`CREATE TABLE monitors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, query TEXT NOT NULL, chart_query TEXT, condition TEXT NOT NULL,
    frequency_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, alert_enabled INTEGER NOT NULL DEFAULT 1,
    last_status TEXT, last_error TEXT, last_checked_at INTEGER, chat_session_id TEXT, sort_order INTEGER, card_width INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  saveMonitor(db, "m1", { name: "A", provider: "newrelic", query: "q", chartQuery: null, condition: "> 0", frequencySeconds: 300 });
  assert.deepEqual(setMonitorToggles(db, "m1", { alert: false }), { name: "A", run: true, alert: false });
  db.update(schema.monitors).set({ lastCheckedAt: 123 }).run();
  assert.deepEqual(setMonitorToggles(db, "m1", { run: false }), { name: "A", run: false, alert: false });
  assert.deepEqual(setMonitorToggles(db, "m1", { run: true }), { name: "A", run: true, alert: false });
  assert.equal(db.select().from(schema.monitors).get()?.lastCheckedAt, null);
  assert.deepEqual(setMonitorToggles(db, "nope", { run: true }), { error: "Monitor not found", code: "NOT_FOUND" });
});

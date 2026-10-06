import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { alertIssues, chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { pruneOldData } from "./scheduler.js";

const NOW = 1_800_000_000;
const OLD = NOW - CONFIG.dataRetentionSeconds - 10;

async function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  await db.insert(monitors).values({ id: "m1", name: "M", query: "q", condition: "{}" }).run();
  await db.insert(chatSessions).values({ id: "live", title: "T", messages: "[]" }).run();
  return { db, sqlite };
}

const trigger = (id: string, triggeredAt: number, sessionId: string | null) =>
  ({ id, monitorId: "m1", triggeredAt, value: 1, windowStart: 0, windowEnd: 0, status: "investigating", groups: "[]", sessionId });

test("old firings are pruned unless a session or an issue still points to them", async () => {
  const { db } = await freshDb();
  await db.insert(monitorTriggers).values([
    trigger("gone", OLD, null),
    trigger("deleted-session", OLD, "missing"),
    trigger("live-session", OLD, "live"),
    trigger("recent", NOW, null),
    trigger("issue", OLD, null),
  ]).run();
  await db.insert(alertIssues).values({ issueId: "i1", monitorId: "m1", triggerId: "issue", sessionId: "x", conditionName: "c", title: "t", state: "pending", createdAt: 0, updatedAt: 0 }).run();

  await pruneOldData(db, NOW);
  assert.deepEqual((await db.select().from(monitorTriggers).all()).map((t) => t.id).sort(), ["issue", "live-session", "recent"]);
});

test("the triage queries use the new indexes", async () => {
  const { sqlite } = await freshDb();
  const plan = (query: string) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT * FROM alert_issues WHERE session_id = 'x' AND state = 'pending'"), /idx_alert_issues_(session|state)/);
  assert.match(plan("SELECT * FROM alert_issues WHERE session_id = 'x'"), /idx_alert_issues_session/);
  assert.match(plan("SELECT count(DISTINCT session_id) FROM alert_issues WHERE monitor_id = 'm' AND condition_name = 'c' AND state = 'closed'"), /idx_alert_issues_condition/);
  assert.match(plan("DELETE FROM monitor_triggers WHERE id = 't'"), /sqlite_autoindex_monitor_triggers/);
  assert.match(plan("SELECT * FROM alert_issues WHERE trigger_id = 't'"), /idx_alert_issues_trigger/);
  assert.equal((sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_monitors_enabled', 'idx_triggers_recent_session')").all()).length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { agentRuns, alertIssues, chatSessions, memoryOperations, monitors, monitorTriggers, sessionTimers, syncRows } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { CONFIG } from "../config.js";
import { isIdle, pruneOldData } from "./scheduler.js";
import { pastSessions, saveOutcome } from "./repeats.js";

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

test("retention removes old monitor sessions and delete markers, and keeps user chats with their runs and memory rows", async () => {
  const { db } = await freshDb();
  await db.insert(chatSessions).values([
    { id: "old-monitor", title: "T", messages: "[]", kind: "monitor", status: "done", updatedAt: OLD },
    { id: "old-watched", title: "T", messages: "[]", kind: "monitor", status: "done", updatedAt: OLD },
    { id: "new-monitor", title: "T", messages: "[]", kind: "monitor", status: "done", updatedAt: NOW },
    { id: "old-chat", title: "T", messages: "[]", status: "done", updatedAt: OLD },
  ]).run();
  await db.insert(monitorTriggers).values([trigger("t-old", OLD, "old-monitor"), trigger("t-watched", OLD, "old-watched")]).run();
  await db.insert(alertIssues).values({ issueId: "i1", monitorId: "m1", triggerId: "t-watched", sessionId: "old-watched", conditionName: "c", title: "t", state: "watching", createdAt: 0, updatedAt: 0 }).run();
  await db.insert(agentRuns).values([{ id: "m-run", sessionId: "old-monitor", agentType: "chat", createdAt: OLD }, { id: "r-old", sessionId: "old-chat", agentType: "chat", createdAt: OLD }, { id: "r-new", sessionId: "old-chat", agentType: "chat", createdAt: NOW }]).run();
  await db.insert(memoryOperations).values([{ sessionId: "old-chat", operation: "added", createdAt: OLD }, { sessionId: "old-chat", operation: "added", createdAt: NOW }]).run();
  await db.delete(syncRows).run();
  await db.insert(syncRows).values([
    { tbl: "x", rowKey: "fresh", changedAt: 0, localAt: NOW * 1000, deleted: 1 },
    { tbl: "x", rowKey: "stale", changedAt: 0, localAt: OLD * 1000, deleted: 1 },
    { tbl: "x", rowKey: "live", changedAt: 0, localAt: OLD * 1000, deleted: 0 },
  ]).run();

  await pruneOldData(db, NOW);
  assert.deepEqual((await db.select({ id: chatSessions.id }).from(chatSessions).all()).map((r) => r.id).sort(), ["live", "new-monitor", "old-chat", "old-watched"]);
  assert.deepEqual((await db.select().from(agentRuns).all()).map((r) => r.id).sort(), ["r-new", "r-old"]);
  assert.equal((await db.select().from(memoryOperations).all()).length, 2);
  assert.deepEqual((await db.select().from(monitorTriggers).all()).map((t) => t.id), ["t-watched"]);
  assert.deepEqual((await db.select().from(syncRows).where(eq(syncRows.tbl, "x")).all()).map((r) => r.rowKey).sort(), ["fresh", "live"]);
});

test("a tick is idle without enabled monitors, pending timers and issues in progress", async () => {
  const { db } = await freshDb();
  assert.equal(await isIdle(db), false, "an enabled monitor");
  await db.update(monitors).set({ enabled: 0 }).run();
  assert.equal(await isIdle(db), true);
  await db.insert(sessionTimers).values({ sessionId: "live", fireAt: null, note: "n", setAt: 0 }).run();
  assert.equal(await isIdle(db), true, "a spent timer");
  await db.update(sessionTimers).set({ fireAt: NOW }).run();
  assert.equal(await isIdle(db), false, "a pending timer");
  await db.delete(sessionTimers).run();
  await db.insert(monitorTriggers).values(trigger("t", NOW, null)).run();
  await db.insert(alertIssues).values({ issueId: "i", monitorId: "m1", triggerId: "t", sessionId: "live", conditionName: "c", title: "t", state: "watching", createdAt: 0, updatedAt: 0 }).run();
  assert.equal(await isIdle(db), false, "a watching issue");
});

test("the new indexes serve the sync and timer queries", async () => {
  const { sqlite } = await freshDb();
  const plan = (query: string) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
  assert.match(plan("SELECT * FROM sync_rows WHERE local_at >= 5"), /idx_sync_rows_local/);
  assert.match(plan("SELECT * FROM session_timers WHERE fire_at <= 5 ORDER BY fire_at"), /idx_session_timers_fire/);
});

test("past sessions read the outcome stored on the firing", async () => {
  const { db } = await freshDb();
  await db.insert(monitorTriggers).values(trigger("a", NOW - 20, "stored-gone")).run();
  const outcome = { analysis: "Pool exhausted.", report: null, latestReport: null, finding: null, dismissed: null };
  await saveOutcome(db, "stored-gone", outcome);
  assert.deepEqual((await pastSessions(db, "m1", [])).map((p) => [p.sessionId, p.analysis]), [["stored-gone", "Pool exhausted."]]);
  await saveOutcome(db, "stored-gone", { ...outcome, dismissed: "closed" });
  assert.deepEqual(await pastSessions(db, "m1", []), []);
});

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import { runInTransaction, type Db } from "../db/driver.js";
import { chatSessions, monitors, monitorTriggers, sessionTimers } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import type { MonitorDraft } from "./validate.js";

/** Window ends whose check failed, per monitor: the next tick skips that window. An edit or delete makes the monitor retry at once. */
export const failedWindowEnds = new Map<string, number>();

/** Drops the follow-up timers of a monitor's sessions, e.g. when the monitor or its alerts turn off. */
async function clearSessionTimers(db: Db, monitorId: string): Promise<void> {
  const ids = (await db.select({ id: monitorTriggers.sessionId }).from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(monitorTriggers.sessionId))).all()).map((r) => r.id as string);
  if (ids.length === 0) return;
  await db.delete(sessionTimers).where(inArray(sessionTimers.sessionId, ids)).run();
  sessionChanged(...ids);
}

export async function saveMonitor(db: Db, id: string, draft: MonitorDraft & { name: string }): Promise<void> {
  failedWindowEnds.delete(id);
  const now = unixNow();
  const fields = {
    name: draft.name,
    provider: draft.provider,
    query: draft.query,
    chartQuery: draft.chartQuery ?? null,
    condition: draft.condition,
    frequencySeconds: draft.frequencySeconds,
    updatedAt: now,
  };
  await db.insert(monitors).values({ ...fields, id, enabled: 1, lastStatus: "ok", createdAt: now })
    .onConflictDoUpdate({ target: monitors.id, set: fields }).run();
}

export async function setMonitorToggles(
  db: Db,
  id: string,
  toggles: { run?: boolean; alert?: boolean },
): Promise<{ name: string; run: boolean; alert: boolean } | { error: string; code: "NOT_FOUND" }> {
  const fields = {
    updatedAt: unixNow(),
    ...(toggles.alert !== undefined ? { alertEnabled: toggles.alert ? 1 : 0 } : {}),
    // Re-enabled monitors resume from now instead of checking the whole paused period.
    ...(toggles.run !== undefined ? { enabled: toggles.run ? 1 : 0, ...(toggles.run ? { lastCheckedAt: null } : {}) } : {}),
  };
  const row = await db.update(monitors).set(fields).where(eq(monitors.id, id))
    .returning({ name: monitors.name, enabled: monitors.enabled, alertEnabled: monitors.alertEnabled }).get();
  if (!row) return { error: "Monitor not found", code: "NOT_FOUND" };
  if (toggles.run === false || toggles.alert === false) await clearSessionTimers(db, id);
  return { name: row.name, run: row.enabled === 1, alert: row.alertEnabled !== 0 };
}

export async function deleteMonitor(db: Db, activeStreams: ReadonlyMap<string, unknown>, id: string): Promise<{ name: string } | { error: string; code: "NOT_FOUND" | "CONFLICT" }> {
  const monitor = await db.select({ name: monitors.name }).from(monitors).where(eq(monitors.id, id)).get();
  if (!monitor) return { error: "Monitor not found", code: "NOT_FOUND" };

  const sessionIds = (await db
    .select({ sessionId: monitorTriggers.sessionId })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, id), isNotNull(monitorTriggers.sessionId)))
    .all())
    .map((r) => r.sessionId as string);
  if (sessionIds.some((s) => activeStreams.has(s))) {
    return { error: "A session for this monitor is still running. Stop it first.", code: "CONFLICT" };
  }

  // Builder chats are kept: one chat can hold several monitors.
  const toDelete = [...new Set(sessionIds)];
  await runInTransaction(db, async (tx) => {
    if (toDelete.length > 0) await tx.delete(chatSessions).where(inArray(chatSessions.id, toDelete)).run();
    await tx.delete(monitors).where(eq(monitors.id, id)).run();
  });
  failedWindowEnds.delete(id);
  sessionChanged(...toDelete);
  return monitor;
}

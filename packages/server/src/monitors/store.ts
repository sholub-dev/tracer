import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Db } from "../db/client.js";
import { chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import type { MonitorDraft } from "./validate.js";

export function saveMonitor(db: Db, id: string, draft: MonitorDraft & { name: string }): void {
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
  db.insert(monitors).values({ ...fields, id, enabled: 1, lastStatus: "ok", createdAt: now })
    .onConflictDoUpdate({ target: monitors.id, set: fields }).run();
}

export function setMonitorToggles(
  db: Db,
  id: string,
  toggles: { run?: boolean; alert?: boolean },
): { name: string; run: boolean; alert: boolean } | { error: string; code: "NOT_FOUND" } {
  const fields = {
    updatedAt: unixNow(),
    ...(toggles.alert !== undefined ? { alertEnabled: toggles.alert ? 1 : 0 } : {}),
    // Re-enabled monitors resume from now instead of checking the whole paused period.
    ...(toggles.run !== undefined ? { enabled: toggles.run ? 1 : 0, ...(toggles.run ? { lastCheckedAt: null } : {}) } : {}),
  };
  const row = db.update(monitors).set(fields).where(eq(monitors.id, id))
    .returning({ name: monitors.name, enabled: monitors.enabled, alertEnabled: monitors.alertEnabled }).get();
  if (!row) return { error: "Monitor not found", code: "NOT_FOUND" };
  return { name: row.name, run: row.enabled === 1, alert: row.alertEnabled !== 0 };
}

export function deleteMonitor(db: Db, activeStreams: ReadonlyMap<string, unknown>, id: string): { name: string } | { error: string; code: "NOT_FOUND" | "CONFLICT" } {
  const monitor = db.select({ name: monitors.name }).from(monitors).where(eq(monitors.id, id)).get();
  if (!monitor) return { error: "Monitor not found", code: "NOT_FOUND" };

  const sessionIds = db
    .select({ sessionId: monitorTriggers.sessionId })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, id), isNotNull(monitorTriggers.sessionId)))
    .all()
    .map((r) => r.sessionId as string);
  if (sessionIds.some((s) => activeStreams.has(s))) {
    return { error: "A session for this monitor is still running. Stop it first.", code: "CONFLICT" };
  }

  // Builder chats are kept: one chat can hold several monitors.
  const toDelete = [...new Set(sessionIds)];
  db.transaction((tx) => {
    if (toDelete.length > 0) tx.delete(chatSessions).where(inArray(chatSessions.id, toDelete)).run();
    tx.delete(monitors).where(eq(monitors.id, id)).run();
  });
  return monitor;
}

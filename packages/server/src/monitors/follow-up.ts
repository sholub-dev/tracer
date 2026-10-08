import { and, eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import type { Db } from "../db/driver.js";
import { alertIssues, monitors, monitorTriggers, sessionTimers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { postSlack, readSlackConfig, recheckUpdate, triageUpdate } from "../integrations/slack.js";
import { putTimer, hasPendingTimer } from "../tools/timer-tool.js";
import { sessionChanged } from "../lib/session-events.js";
import type { AlertSummary } from "./alert-summary.js";
import { outcomeSummary, readOutcome } from "./repeats.js";
import type { Triage } from "./triage.js";

const EXPIRED_ACTION = "Still ongoing after 24h. Re-checks stopped.";

/** True when the session belongs to a firing whose monitor is gone, paused or has alerts off. */
export async function monitorStopped(db: Db, sessionId: string): Promise<boolean> {
  const row = await db.select({ enabled: monitors.enabled, alertEnabled: monitors.alertEnabled }).from(monitorTriggers)
    .leftJoin(monitors, eq(monitors.id, monitorTriggers.monitorId)).where(eq(monitorTriggers.sessionId, sessionId)).get();
  return !!row && (row.enabled !== 1 || row.alertEnabled === 0);
}

async function dropTimer(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessionTimers).where(eq(sessionTimers.sessionId, sessionId)).run();
  sessionChanged(sessionId);
}

/**
 * Duty of a monitor session: an ongoing alert always has a next check. Returns true when the 24h ownership ended, with no timer left.
 * A paused monitor or one with alerts off keeps no timer.
 */
export async function ensureFollowUp(context: Context, sessionId: string, report: AlertSummary | null): Promise<boolean> {
  const { db } = context;
  if (await monitorStopped(db, sessionId)) {
    await dropTimer(db, sessionId);
    return false;
  }
  if (report?.state !== "ongoing") return false;
  const trigger = await db.select({ triggeredAt: monitorTriggers.triggeredAt }).from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
  if (!trigger) return false;
  if (unixNow() >= trigger.triggeredAt + CONFIG.triageWatchMaxSeconds) {
    await dropTimer(db, sessionId);
    // The final line below covers these issues; the orphan sweep must not post a second one.
    await db.update(alertIssues).set({ state: "left_open", updatedAt: unixNow() })
      .where(and(eq(alertIssues.sessionId, sessionId), eq(alertIssues.state, "watching"))).run();
    return true;
  }
  if (!await hasPendingTimer(db, sessionId)) await putTimer(db, sessionId, CONFIG.timerFollowUpMinutes, "Check whether the alert is still ongoing");
  return false;
}

/** The one final line when the 24h ownership ended; never throws. */
export async function postExpiry(context: Context, sessionId: string): Promise<void> {
  try {
    const slack = await readSlackConfig(context.db);
    if (!slack) return;
    const trigger = await context.db.select({ name: monitors.name }).from(monitorTriggers)
      .innerJoin(monitors, eq(monitors.id, monitorTriggers.monitorId)).where(eq(monitorTriggers.sessionId, sessionId)).get();
    if (!trigger) return;
    const result = await postSlack(slack.webhookUrl, triageUpdate({ name: trigger.name, action: EXPIRED_ACTION, ping: true, mentions: slack.mentions }));
    if ("error" in result) console.warn(`[monitor] "${trigger.name}" Slack post failed:`, result.error);
  } catch (err) {
    console.warn("[monitor] expiry Slack post failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Slack update after a finished re-check of a monitor session; never throws. */
export async function postRecheck(context: Context, sessionId: string, triage: Triage | null, expired: boolean): Promise<void> {
  const { db } = context;
  try {
    const slack = await readSlackConfig(db);
    if (!slack) return;
    const trigger = await db.select({ name: monitors.name }).from(monitorTriggers)
      .innerJoin(monitors, eq(monitors.id, monitorTriggers.monitorId)).where(eq(monitorTriggers.sessionId, sessionId)).get();
    if (!trigger) return;
    const outcome = await readOutcome(db, sessionId);
    const { name } = trigger;
    // Only this run's report counts: an older one would repeat a stale state.
    const report = outcome.latestReport;
    const result = await postSlack(slack.webhookUrl, recheckUpdate({
      name,
      headline: outcomeSummary(outcome),
      state: report?.state,
      action: triage?.action,
      ping: report?.notify === true || triage?.ping === true,
      mentions: slack.mentions,
    }));
    if ("error" in result) console.warn(`[monitor] "${trigger.name}" Slack post failed:`, result.error);
    if (expired) await postExpiry(context, sessionId);
  } catch (err) {
    console.warn("[monitor] re-check Slack post failed:", err instanceof Error ? err.message : String(err));
  }
}

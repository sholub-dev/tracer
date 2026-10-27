import { and, eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import type { Db } from "../db/driver.js";
import { alertIssues, monitors, monitorTriggers, sessionTimers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { postSlack, readSlackConfig, recheckUpdate, triageUpdate } from "../integrations/slack.js";
import { hasPendingTimer } from "../tools/timer-tool.js";
import { sessionChanged } from "../lib/session-events.js";
import type { AlertSummary } from "./alert-summary.js";
import { outcomeSummary, readOutcome } from "./repeats.js";
import { TERMINAL_STATES, type Triage } from "./triage.js";

export type FollowUpEnd = "expired" | "handover";

const HANDOVER_ACTION = "Tracer stopped re-checking. A person needs to look.";

/** The action and ping of a post that hands the alert to a person; it keeps what triage reported. */
export function handedOver(triage: Triage | null | undefined): Triage {
  return { action: triage?.action ? `${triage.action}. ${HANDOVER_ACTION}` : HANDOVER_ACTION, ping: true };
}

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

const CLOSED_STATES = ["closed", "nr_closed"];

/** True when the session has issues and every one is in one of the states: no re-check can change anything. */
export async function issuesEnded(db: Db, sessionId: string, states = TERMINAL_STATES): Promise<boolean> {
  const rows = await db.select({ state: alertIssues.state }).from(alertIssues).where(eq(alertIssues.sessionId, sessionId)).all();
  return rows.length > 0 && rows.every((r) => states.includes(r.state));
}

/**
 * Ends the re-check chain of a monitor session when it has no more to do. Only a timer the agent set continues it.
 * Returns "expired" when the 24h ownership ended and "handover" when the latest report is ongoing and no timer is left;
 * the caller posts the line. A paused monitor, one with alerts off or one whose issues all ended keeps no timer.
 */
export async function ensureFollowUp(context: Context, sessionId: string, report: AlertSummary | null): Promise<FollowUpEnd | null> {
  const { db } = context;
  if (await monitorStopped(db, sessionId) || await issuesEnded(db, sessionId, CLOSED_STATES)) {
    await dropTimer(db, sessionId);
    return null;
  }
  const trigger = await db.select({ triggeredAt: monitorTriggers.triggeredAt }).from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
  const open = report?.state === "ongoing" || report?.state === "unclear";
  if (open && trigger && unixNow() >= trigger.triggeredAt + CONFIG.triageWatchMaxSeconds) {
    await dropTimer(db, sessionId);
    // The final line covers these issues; the orphan sweep must not post a second one.
    await leaveWatchingOpen(db, sessionId);
    return "expired";
  }
  // A person must act on the issues left open, so no timer wakes the session for them.
  if (await issuesEnded(db, sessionId)) {
    await dropTimer(db, sessionId);
    return null;
  }
  if (report?.state !== "ongoing" || !trigger || await hasPendingTimer(db, sessionId)) return null;
  await leaveWatchingOpen(db, sessionId);
  return "handover";
}

async function leaveWatchingOpen(db: Db, sessionId: string): Promise<void> {
  await db.update(alertIssues).set({ state: "left_open", updatedAt: unixNow() })
    .where(and(eq(alertIssues.sessionId, sessionId), eq(alertIssues.state, "watching"))).run();
}

/** The one final line when the chain ended outside a re-check post; never throws. */
export async function postEnd(context: Context, sessionId: string, end: FollowUpEnd): Promise<void> {
  try {
    const slack = await readSlackConfig(context.db);
    if (!slack) return;
    const trigger = await context.db.select({ name: monitors.name }).from(monitorTriggers)
      .innerJoin(monitors, eq(monitors.id, monitorTriggers.monitorId)).where(eq(monitorTriggers.sessionId, sessionId)).get();
    if (!trigger) return;
    const action = end === "handover" ? HANDOVER_ACTION : `Still ${(await readOutcome(context.db, sessionId)).latestReport?.state ?? "unresolved"} after 24h. Re-checks stopped.`;
    const result = await postSlack(slack.webhookUrl, triageUpdate({ name: trigger.name, action, ping: true, mentions: slack.mentions }));
    if ("error" in result) console.warn(`[monitor] "${trigger.name}" Slack post failed:`, result.error);
  } catch (err) {
    console.warn("[monitor] final Slack post failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Slack update after a finished re-check of a monitor session; never throws. */
export async function postRecheck(context: Context, sessionId: string, triage: Triage | null, end: FollowUpEnd | null): Promise<void> {
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
    const post = end === "handover" ? handedOver(triage) : triage;
    const result = await postSlack(slack.webhookUrl, recheckUpdate({
      name,
      headline: outcomeSummary(outcome),
      state: report?.state,
      action: post?.action,
      ping: report?.notify === true || post?.ping === true,
      mentions: slack.mentions,
    }));
    if ("error" in result) console.warn(`[monitor] "${trigger.name}" Slack post failed:`, result.error);
    if (end === "expired") await postEnd(context, sessionId, end);
  } catch (err) {
    console.warn("[monitor] re-check Slack post failed:", err instanceof Error ? err.message : String(err));
  }
}

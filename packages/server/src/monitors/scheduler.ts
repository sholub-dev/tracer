import { and, desc, eq, gt, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { SESSION_KIND, substituteWindow, unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { alertIssues, chatSessions, monitors, monitorTriggers, sessionTimers, syncRows } from "../db/schema.js";
import type { Db } from "../db/driver.js";
import { startAgentSession } from "../agents/start-session.js";
import { sessionChanged } from "../lib/session-events.js";
import { pendingResume } from "../lib/pending-resume.js";
import { pendingFiringsChanged } from "../lib/firing-events.js";
import { CONFIG } from "../config.js";
import { localDeviceId } from "../db/config-reader.js";
import { decodeMessages } from "../lib/messages-codec.js";
import { failedWindowEnds } from "./store.js";
import { evaluateGroups, extractGroups, isNoData, parseCondition, type Group } from "./condition.js";
import { classifyGroups, parseTriggerGroups, pastSessions, pastSummary, readOutcome, readPastSessionTool, saveOutcome, type Outcome, type PastSession, type TriggerGroup } from "./repeats.js";
import { withTimeout } from "../lib/with-timeout.js";
import { getTimezone } from "../lib/current-context.js";
import { monitorAlert, postSlack, readSlackConfig } from "../integrations/slack.js";
import { dismissAlertTool, MONITOR_ROLE, reportAlertSummaryTool, summaryInstruction } from "./alert-summary.js";
import { fireDueTimers } from "./timers.js";
import { ensureFollowUp, handedOver } from "./follow-up.js";
import {
  ackRemaining, checkWatches, closeCounts, closedCheckPrompt, conditionOf, findIssues, forgetReports, incidentQuery, ingestLagSeconds, triageEnabled, issuesPrompt, isWakeupTurn, pendingIssueIds, recordIssues, wakeupFailed,
  monitorIssueTools, reportIssueStatusTool, triageAfterRun, type FoundIssues, type Triage,
} from "./triage.js";

type Monitor = typeof monitors.$inferSelect;
type RunOutcome = { error?: string };

/** Windows end on clock boundaries (:00, :05, ...); each runs `lag` after its end so late events are in. */
export function nextWindow(
  lastCheckedAt: number | null,
  frequencySeconds: number,
  now: number,
  lagSeconds: number = CONFIG.monitorIngestLagSeconds,
  catchUp = false,
): { start: number; end: number } | null {
  const end = Math.floor((now - lagSeconds) / frequencySeconds) * frequencySeconds;
  if (lastCheckedAt !== null && end <= lastCheckedAt) return null;
  // A check at an unaligned time (the app opening) must not shorten the next window: it still spans a full period.
  // After a long sleep the missed time is not summed into one check: the window covers at most two periods.
  // Incident events are not counted, so those monitors cover the whole sleep, up to the catch-up limit.
  const span = 2 * frequencySeconds;
  const start = Math.max(Math.min(lastCheckedAt ?? end - frequencySeconds, end - frequencySeconds), end - (catchUp ? Math.max(CONFIG.monitorCatchUpSeconds, span) : span));
  return { start, end };
}

/** A full-period window ending now (less the lag); null when the monitor was checked just before. */
export function openWindow(
  lastCheckedAt: number | null,
  frequencySeconds: number,
  now: number,
  lagSeconds: number = CONFIG.monitorIngestLagSeconds,
  catchUp = false,
): { start: number; end: number } | null {
  const end = now - lagSeconds;
  if (lastCheckedAt !== null && lastCheckedAt >= end - CONFIG.monitorOpenSkipSeconds) return null;
  // A shorter window would change what a count condition sees; a crossing already investigated is muted when it fires.
  if (!catchUp || lastCheckedAt === null) return { start: end - frequencySeconds, end };
  return { start: Math.max(Math.min(lastCheckedAt, end - frequencySeconds), end - Math.max(CONFIG.monitorCatchUpSeconds, frequencySeconds)), end };
}

/** A failed window is retried at the next clock boundary, not every tick; the next window still starts at lastCheckedAt. */
export function isFailedWindow(failedEnds: Map<string, number>, monitorId: string, windowEnd: number): boolean {
  return failedEnds.get(monitorId) === windowEnd;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function groupLabel(g: Pick<Group, "key" | "count">): string {
  return g.key === "" ? `count ${g.count}` : `${g.key}: ${g.count}`;
}

function sessionTitle(name: string, classified: TriggerGroup[]): string {
  const keys = classified.filter((g) => g.key).map((g) => g.key).join(", ");
  const title = keys ? `${name}: ${keys}` : name;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

export function buildMessage(
  monitor: Monitor,
  value: number,
  window: { start: number; end: number },
  classified: TriggerGroup[],
  past: PastSession[],
  triageLines: string[] = [],
  dismissible = false,
  slack = false,
): string {
  const lines = [
    `Monitor "${monitor.name}" triggered.`,
    "",
    `Query (${monitor.provider === "posthog" ? "PostHog HogQL" : "New Relic"}):`,
    "```",
    monitor.query,
    "```",
    `Value: ${value} (condition: value ${monitor.condition})`,
    `Window: ${iso(window.start)} to ${iso(window.end)} (the query's {{SINCE}}/{{UNTIL}} are this window in epoch ${monitor.provider === "posthog" ? "seconds" : "ms"})`,
    "",
    "Groups that fired:",
    ...classified.map((g) => `- ${groupLabel(g)}${g.repeat ? " (fired before)" : ""}`),
  ];
  if (past.length > 0) {
    lines.push("", "Recent past sessions of this monitor (open one with read_past_session if it helps):");
    for (const p of past) {
      lines.push(`- ${iso(p.triggeredAt)} groups: ${p.keys.join(", ") || "none"} session ${p.sessionId}: ${pastSummary(p) || "no summary"}`);
    }
  }
  lines.push(...triageLines);
  lines.push(
    "",
    MONITOR_ROLE,
    "",
    "If this looks like a past issue, its past cause is only a hypothesis. Read the most relevant past session, then check in this window that the same cause appears, starts before this firing and explains its groups and size. If it does, say which session; if any part differs, investigate fully.",
    `${dismissible ? "Unless you dismissed the alert, find" : "Find"} the root cause, or state where the data stops. Answer with report_finding as in any session.${summaryInstruction(slack)}`,
  );
  return lines.join("\n");
}

/** Never throws: a Slack failure is only logged. */
async function notifySlack(
  context: Context, monitor: Monitor, triggeredAt: number, sessionId: string, triage?: Triage, outcome?: Outcome,
): Promise<void> {
  let error: string;
  try {
    const slack = await readSlackConfig(context.db);
    if (!slack) return;
    const { report, finding } = outcome ?? await readOutcome(context.db, sessionId);
    const result = await postSlack(slack.webhookUrl, monitorAlert({
      name: monitor.name,
      triggeredAt,
      summary: report,
      finding,
      timeZone: await getTimezone(context.db),
      mentions: slack.mentions,
      ...triage,
      ping: triage ? triage.ping || report?.notify === true : report ? report.notify === true : undefined,
    }));
    if (!("error" in result)) return;
    error = result.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  console.warn(`[monitor] "${monitor.name}" Slack post failed:`, error);
}

// A failure is reported once; a later finished run (e.g. Retry) is still reported.
async function claimFiring(context: Context, sessionId: string, failed: boolean): Promise<boolean> {
  const unreported = failed ? isNull(monitorTriggers.reported) : or(isNull(monitorTriggers.reported), eq(monitorTriggers.reported, "failed"));
  const claimed = await context.db.update(monitorTriggers).set({ reported: failed ? "failed" : "done" })
    .where(and(eq(monitorTriggers.sessionId, sessionId), unreported))
    .returning({ id: monitorTriggers.id }).all();
  return claimed.length > 0;
}

/** Triage and the Slack post after a firing's run; never throws. Without `found` (a re-run) triage uses the recorded issues. */
async function completeFiring(
  context: Context, monitor: Monitor, triggeredAt: number, sessionId: string, found: FoundIssues | null | undefined, { error }: RunOutcome,
): Promise<void> {
  try {
    if (!await claimFiring(context, sessionId, error !== undefined)) return;
    if (error !== undefined) {
      // Issues stay pending so a Retry can still triage them; the stale sweep leaves them open after an hour.
      await forgetReports(context.db, sessionId);
      // The provider's error text stays in the local log; Slack gets a fixed line.
      console.warn(`[monitor] "${monitor.name}" investigation failed:`, error);
      await notifySlack(context, monitor, triggeredAt, sessionId, {
        action: "Investigation failed. Issues it did not close stay open.",
        ping: true,
      });
      return;
    }
    const outcome = await readOutcome(context.db, sessionId);
    await saveOutcome(context.db, sessionId, outcome);
    if (outcome.dismissed !== null) {
      console.log(`[monitor] "${monitor.name}" alert already closed, not posted: ${outcome.dismissed}`);
      return;
    }
    const end = await ensureFollowUp(context, sessionId, outcome.latestReport);
    const triage = await triageAfterRun(context, sessionId, found);
    await ackRemaining(context, sessionId);
    await notifySlack(context, monitor, triggeredAt, sessionId, end === "handover" ? handedOver(triage) : triage, outcome);
  } catch (err) {
    console.error(`[monitor] "${monitor.name}" completion failed:`, err instanceof Error ? err.message : err);
  }
}

/** The tools and completion of a firing's session for a re-run such as Retry; null once its run was reported. */
export async function firingRerun(context: Context, sessionId: string): Promise<{ tools: Record<string, unknown>; onComplete: (outcome: RunOutcome) => void } | null> {
  const { db } = context;
  const trigger = await db.select({ monitorId: monitorTriggers.monitorId, triggeredAt: monitorTriggers.triggeredAt, reported: monitorTriggers.reported })
    .from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
  if (!trigger || trigger.reported === "done") return null;
  const monitor = await db.select().from(monitors).where(eq(monitors.id, trigger.monitorId)).get();
  if (!monitor) return null;
  const pending = await pendingIssueIds(db, sessionId);
  return {
    tools: {
      report_alert_summary: reportAlertSummaryTool({ slack: await readSlackConfig(db) !== null }),
      ...(pending.length > 0 ? { report_issue_status: reportIssueStatusTool(db, pending, sessionId), ...monitorIssueTools(context, pending, sessionId) }
        : incidentQuery(monitor.query) ? { dismiss_alert: dismissAlertTool() } : {}),
    },
    onComplete: (outcome) => void completeFiring(context, monitor, trigger.triggeredAt, sessionId, undefined, outcome),
  };
}

/**
 * Closes out a monitor run that never started again after a restart: an unreported firing is reported as failed;
 * an interrupted wake-up is settled as a failed re-check. Never throws.
 */
export async function settleMonitorRun(context: Context, sessionId: string, error: string): Promise<void> {
  try {
    const { db } = context;
    const trigger = await db.select({ monitorId: monitorTriggers.monitorId, triggeredAt: monitorTriggers.triggeredAt, reported: monitorTriggers.reported })
      .from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
    if (!trigger) return;
    if (trigger.reported === null) {
      const monitor = await db.select().from(monitors).where(eq(monitors.id, trigger.monitorId)).get();
      if (monitor) await completeFiring(context, monitor, trigger.triggeredAt, sessionId, undefined, { error });
      return;
    }
    const row = await db.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
    if (row && isWakeupTurn(decodeMessages(row.messages))) await wakeupFailed(context, sessionId);
  } catch (err) {
    console.error("[monitor] settling an interrupted run failed:", err instanceof Error ? err.message : err);
  }
}

async function setStatus(context: Context, monitorId: string, fields: Partial<Pick<Monitor, "lastStatus" | "lastError" | "lastCheckedAt">>): Promise<void> {
  await context.db.update(monitors).set(fields).where(eq(monitors.id, monitorId)).run();
}

async function fail(context: Context, monitorId: string, windowEnd: number, message: string): Promise<void> {
  failedWindowEnds.set(monitorId, windowEnd);
  await setStatus(context, monitorId, { lastStatus: "error", lastError: message });
}

async function succeed(context: Context, monitorId: string, lastStatus: "ok" | "triggered", windowEnd: number): Promise<void> {
  failedWindowEnds.delete(monitorId);
  await setStatus(context, monitorId, { lastStatus, lastError: null, lastCheckedAt: windowEnd });
}

export async function latestSessionRunning(context: Context, monitorId: string): Promise<boolean> {
  const latest = await context.db
    .select({ sessionId: monitorTriggers.sessionId })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(monitorTriggers.sessionId)))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .limit(1)
    .get();
  // A session a restart interrupted counts as running until its run starts again.
  return !!latest?.sessionId && (context.activeStreams.has(latest.sessionId) || pendingResume.has(latest.sessionId));
}

/** True when an earlier session of the monitor has a re-check pending: it owns the alert and its re-check covers a new crossing. */
async function ownedByRecheck(db: Db, monitorId: string): Promise<boolean> {
  return !!await db.select({ id: sessionTimers.sessionId }).from(sessionTimers)
    .innerJoin(monitorTriggers, eq(monitorTriggers.sessionId, sessionTimers.sessionId))
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(sessionTimers.fireAt))).get();
}

/**
 * True when an earlier firing already covers this one. With issue data: every open issue is tracked (on either device)
 * or acked, and none is new. Without it: a trigger of this monitor on any device started a session for an overlapping window.
 * Aligned consecutive windows only touch, so the next one still starts a session.
 * A catch-up window never counts the overlap.
 */
async function handledElsewhere(db: Db, monitor: Monitor, window: { start: number; end: number }, found: FoundIssues | null, catchUp: boolean): Promise<boolean> {
  if (found) return !("error" in found) && found.tracked > 0 && found.open.length === 0 && found.closed.length === 0;
  // A catch-up window starts where this device's last check ended, so an overlapping firing is another device's and would mute a new incident.
  if (catchUp) return false;
  return !!await db.select({ id: monitorTriggers.id }).from(monitorTriggers).where(and(
    eq(monitorTriggers.monitorId, monitor.id),
    isNotNull(monitorTriggers.sessionId),
    lt(monitorTriggers.windowStart, window.end),
    gt(monitorTriggers.windowEnd, window.start),
  )).get();
}

/** Removes a firing whose session did not start, so the chart shows no trigger without a debug and the window retries. */
async function discardFiring(context: Context, triggerId: string, sessionId: string): Promise<void> {
  await context.db.delete(alertIssues).where(eq(alertIssues.sessionId, sessionId)).run();
  await context.db.delete(monitorTriggers).where(eq(monitorTriggers.id, triggerId)).run();
  await context.db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
  sessionChanged(sessionId);
}

/** True while a firing of the monitor on this device waits for its Yes or No: that crossing covers a new one. */
async function hasPendingFiring(db: Db, monitorId: string): Promise<boolean> {
  // A synced pending row of another device settles only there, so it can stay pending for hours.
  return !!await db.select({ id: monitorTriggers.id }).from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), eq(monitorTriggers.status, "pending"), eq(monitorTriggers.deviceId, await localDeviceId(db)))).get();
}

/** A No holds while the monitor keeps crossing: the previous window was skipped and it covered every group that fires now. */
async function continuesSkip(db: Db, monitorId: string, window: { start: number }, groups: Pick<Group, "key">[]): Promise<boolean> {
  const previous = await db.select({ status: monitorTriggers.status, groups: monitorTriggers.groups, windowEnd: monitorTriggers.windowEnd }).from(monitorTriggers)
    .where(eq(monitorTriggers.monitorId, monitorId)).orderBy(desc(monitorTriggers.windowEnd), desc(monitorTriggers.triggeredAt)).limit(1).get();
  // A window start after the skipped window's end means a window in between was checked and not crossing.
  if (previous?.status !== "skipped" || previous.windowEnd < window.start) return false;
  const keys = new Set(parseTriggerGroups(previous.groups).map((g) => g.key));
  return groups.every((g) => keys.has(g.key));
}

async function checkMonitor(context: Context, monitor: Monitor, window: { start: number; end: number }, start: typeof startAgentSession): Promise<void> {
  await context.providers.whenLoaded();
  await context.providers.reconnectDisconnected();
  const provider = context.providers.getProvider(monitor.provider);
  if (!provider?.connected) {
    // No backoff: cheap, and the provider can connect on a later check.
    await setStatus(context, monitor.id, { lastStatus: "error", lastError: `Provider ${monitor.provider} is not connected` });
    return;
  }

  const condition = parseCondition(monitor.condition);
  if (!condition) {
    await fail(context, monitor.id, window.end, `Invalid condition "${monitor.condition}"`);
    return;
  }

  let result: unknown;
  try {
    result = await withTimeout(
      provider.executeRawQuery(substituteWindow(monitor.provider, monitor.query, window.start, window.end)),
      CONFIG.monitorQueryTimeoutMs,
      `monitor "${monitor.name}"`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[monitor] "${monitor.name}" query error:`, message);
    await fail(context, monitor.id, window.end, message);
    return;
  }

  const extracted = extractGroups(result, monitor.provider);
  const evaluation = evaluateGroups(condition, extracted);
  const { value } = evaluation;
  if (isNoData(result, extracted) || !evaluation.fires) {
    await succeed(context, monitor.id, "ok", window.end);
    return;
  }

  const now = unixNow();
  // A true condition with no rows (e.g. "< 1") still needs one group to track.
  const groups = evaluation.groups.length > 0 ? evaluation.groups : [{ key: "", count: value, additive: true }];
  // Re-read toggles: the user may have changed them while the query ran.
  const current = await context.db.select({ enabled: monitors.enabled, alertEnabled: monitors.alertEnabled })
    .from(monitors).where(eq(monitors.id, monitor.id)).get();
  if (!current?.enabled) return;
  // With alerts off, record the firing but never start a session.
  const alerting = current.alertEnabled !== 0;
  const classified = alerting
    ? await classifyGroups(context.db, monitor.id, groups, now)
    : groups.map((g) => ({ ...g, sessionId: null, repeat: false }));
  const onIncidents = incidentQuery(monitor.query) !== null;
  const found: FoundIssues | null = alerting && await triageEnabled(context.db) && onIncidents ? await findIssues(context, monitor, window) : null;
  // An earlier firing (this device, the other device or a person) already handled it: it is recorded, but no session starts.
  const catchUp = onIncidents && window.end - window.start > monitor.frequencySeconds;
  // A catch-up window starts a session only for an issue still open: the alert may have closed while the app slept.
  // With no matched issue at all nothing shows it closed, so the session checks it.
  const closed = alerting && catchUp && !!found && !("error" in found) && found.open.length === 0 && found.closed.length > 0;
  const handled = alerting && (closed || await handledElsewhere(context.db, monitor, window, found, catchUp));
  // The latest session still runs: it covers this crossing. The firing is recorded as muted, not dropped with its window.
  const busy = alerting && !handled && (await latestSessionRunning(context, monitor.id) || await hasPendingFiring(context.db, monitor.id));
  // Without issue data nothing tells a new alert from the owned one; with it, a new open issue still gets its own session.
  const owned = alerting && !handled && !busy && !(found && !("error" in found)) && await ownedByRecheck(context.db, monitor.id);
  const asking = alerting && !handled && !busy && !owned;
  // After a No the same incident stays quiet: no banner, no session.
  const skipped = asking && await continuesSkip(context.db, monitor.id, window, groups);
  const triggerId = crypto.randomUUID();
  try {
    // Insert first: the monitor_id FK fails if the monitor was deleted mid-check.
    await context.db.insert(monitorTriggers).values({
      id: triggerId,
      monitorId: monitor.id,
      triggeredAt: now,
      value,
      windowStart: window.start,
      windowEnd: window.end,
      status: skipped ? "skipped" : asking ? "pending" : closed ? "closed" : "muted",
      groups: JSON.stringify(classified.map((g) => (g.repeat ? g : { ...g, sessionId: null }))),
      sessionId: null,
      deviceId: await localDeviceId(context.db),
    }).run();
  } catch (err) {
    console.warn(`[monitor] "${monitor.name}" trigger not recorded (monitor deleted?):`, err instanceof Error ? err.message : err);
    return;
  }

  const pending = asking && !skipped;
  if (pending) scheduleDeadline(context, triggerId, start);
  console.log(`[monitor] "${monitor.name}" triggered (value ${value}${pending ? ", starts after the countdown" : skipped ? ", skipped after a No" : closed ? ", alert already closed" : handled ? ", already handled" : busy ? ", earlier session still running" : owned ? ", earlier session re-checks it" : ", alerts off"})`);
  await succeed(context, monitor.id, "triggered", window.end);
  if (pending) pendingFiringsChanged();
}

const deadlines = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number }>();

function scheduleDeadline(context: Context, triggerId: string, start: typeof startAgentSession): void {
  const ms = CONFIG.monitorFiringConfirmSeconds * 1000;
  const timer = setTimeout(() => {
    resolveFiring(context, triggerId, "start", start)
      .catch((err) => console.error("[monitor] firing start failed:", err instanceof Error ? err.message : err));
  }, ms);
  // A restart before the deadline finds the row pending and settles it; the timer must not keep the process alive.
  timer.unref?.();
  // The countdown starts when the row exists, not at triggeredAt: the issue lookup before the insert can take seconds.
  deadlines.set(triggerId, { timer, at: Date.now() + ms });
}

/** Starts the session of a claimed firing. Returns an error text when it did not start; the firing is then removed. */
async function startFiring(context: Context, monitor: Monitor, trigger: typeof monitorTriggers.$inferSelect, sessionId: string, classified: TriggerGroup[], start: typeof startAgentSession): Promise<string | null> {
  const window = { start: trigger.windowStart, end: trigger.windowEnd };
  try {
    const onIncidents = incidentQuery(monitor.query) !== null;
    const found: FoundIssues | null = await triageEnabled(context.db) && onIncidents ? await findIssues(context, monitor, window) : null;
    const past = await pastSessions(context.db, monitor.id, classified.map((g) => g.key), trigger.triggeredAt);
    // A concurrent firing of another monitor may have recorded an issue first; this session gets only its own.
    const owned = found && !("error" in found) ? await recordIssues(context.db, { monitorId: monitor.id, triggerId: trigger.id, sessionId }, found) : new Set<string>();
    const openIssues = found && !("error" in found) ? found.open.filter((i) => owned.has(i.issueId)) : [];
    const issueIds = openIssues.map((i) => i.issueId);
    const checkClosed = onIncidents && openIssues.length === 0;
    const slack = await readSlackConfig(context.db) !== null;
    const message = buildMessage(monitor, trigger.value, window, classified, past, checkClosed ? closedCheckPrompt(found, slack) : issuesPrompt(openIssues, await closeCounts(context.db, monitor.id, sessionId, openIssues.map((i) => ({ issueId: i.issueId, conditionName: conditionOf(i) })))), checkClosed, slack);
    const started = await start(context, {
      sessionId,
      kind: SESSION_KIND.MONITOR,
      title: sessionTitle(monitor.name, classified),
      message,
      tools: {
        read_past_session: readPastSessionTool(() => past),
        report_alert_summary: reportAlertSummaryTool({ slack }),
        ...(openIssues.length > 0 ? { report_issue_status: reportIssueStatusTool(context.db, issueIds, sessionId), ...monitorIssueTools(context, issueIds, sessionId) } : {}),
        ...(checkClosed ? { dismiss_alert: dismissAlertTool() } : {}),
      },
      onComplete: (outcome) => void completeFiring(context, monitor, trigger.triggeredAt, sessionId, found, outcome),
    });
    if ("error" in started) {
      await discardFiring(context, trigger.id, sessionId);
      return `Could not start session: ${started.error}`;
    }
    return null;
  } catch (err) {
    await discardFiring(context, trigger.id, sessionId);
    throw err;
  }
}

/**
 * Settles a pending firing once: "start" begins its session, "skip" records it as skipped. The first call wins;
 * a later one (the other button, a second window, the deadline) finds the firing settled and does nothing.
 */
export async function resolveFiring(
  context: Context, triggerId: string, decision: "start" | "skip", start = startAgentSession,
): Promise<{ sessionId: string | null }> {
  const { db } = context;
  clearTimeout(deadlines.get(triggerId)?.timer);
  deadlines.delete(triggerId);
  const none = { sessionId: null };
  const trigger = await db.select().from(monitorTriggers).where(and(eq(monitorTriggers.id, triggerId), eq(monitorTriggers.status, "pending"))).get();
  if (!trigger) return none;
  const monitor = await db.select().from(monitors).where(eq(monitors.id, trigger.monitorId)).get();
  const alerting = !!monitor && monitor.enabled === 1 && monitor.alertEnabled !== 0;
  const status = decision === "skip" ? "skipped" : alerting ? "investigating" : "muted";
  const sessionId = status === "investigating" ? crypto.randomUUID() : null;
  const classified = parseTriggerGroups(trigger.groups).map((g) => (g.repeat ? g : { ...g, sessionId }));
  const claimed = await db.update(monitorTriggers).set({ status, sessionId, groups: JSON.stringify(classified) })
    .where(and(eq(monitorTriggers.id, triggerId), eq(monitorTriggers.status, "pending"))).returning({ id: monitorTriggers.id }).all();
  if (claimed.length === 0) return none;
  pendingFiringsChanged();
  if (!sessionId || !monitor) return none;

  let error: string | null;
  try {
    error = await startFiring(context, monitor, trigger, sessionId, classified, start);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[monitor] "${monitor.name}" firing failed:`, error);
  }
  if (error === null) return { sessionId };
  // Back to before the crossing, so the window is checked again at the next clock boundary, not every tick.
  failedWindowEnds.set(monitor.id, trigger.windowEnd);
  await context.db.update(monitors).set({ lastStatus: "error", lastError: error, lastCheckedAt: trigger.windowStart })
    .where(and(eq(monitors.id, monitor.id), eq(monitors.lastCheckedAt, trigger.windowEnd))).run();
  return none;
}

/** Starts the firings whose countdown ended without a decision: a restart or a suspended app lost their timers. */
export async function settlePendingFirings(context: Context, start = startAgentSession, now = unixNow()): Promise<void> {
  const due = await context.db.select({ id: monitorTriggers.id }).from(monitorTriggers).where(and(
    eq(monitorTriggers.status, "pending"),
    eq(monitorTriggers.deviceId, await localDeviceId(context.db)),
    lte(monitorTriggers.triggeredAt, now - CONFIG.monitorFiringConfirmSeconds),
  )).all();
  // A firing whose countdown still runs waits for it.
  for (const { id } of due) if ((deadlines.get(id)?.at ?? 0) <= now * 1000) await resolveFiring(context, id, "start", start);
}

export interface PendingFiring {
  id: string;
  monitorName: string;
  detail: string;
  /** Time left at this read, from the server's clock; the client counts down from it. */
  remainingMs: number;
}

/** The firings of this device that wait for a Yes or No. */
export async function pendingFirings(db: Db): Promise<PendingFiring[]> {
  const rows = await db.select({ id: monitorTriggers.id, name: monitors.name, condition: monitors.condition, value: monitorTriggers.value, groups: monitorTriggers.groups, triggeredAt: monitorTriggers.triggeredAt })
    .from(monitorTriggers).innerJoin(monitors, eq(monitors.id, monitorTriggers.monitorId))
    .where(and(eq(monitorTriggers.status, "pending"), eq(monitorTriggers.deviceId, await localDeviceId(db)))).orderBy(monitorTriggers.triggeredAt).all();
  const nowMs = Date.now();
  return rows.map((r) => {
    const keys = parseTriggerGroups(r.groups).filter((g) => g.key).slice(0, 2).map(groupLabel);
    const deadline = deadlines.get(r.id)?.at ?? (r.triggeredAt + CONFIG.monitorFiringConfirmSeconds) * 1000;
    return {
      id: r.id,
      monitorName: r.name,
      detail: [`Value ${r.value}, condition ${r.condition}`, ...keys].join(" · "),
      remainingMs: Math.max(0, Math.min(deadline - nowMs, CONFIG.monitorFiringConfirmSeconds * 1000)),
    };
  });
}

async function runMonitors(
  context: Context, start: typeof startAgentSession, windowFor: (monitor: Monitor) => { start: number; end: number } | null,
): Promise<void> {
  const enabled = await context.db.select().from(monitors).where(eq(monitors.enabled, 1)).all();
  const queue = [...enabled];
  const runOne = async (monitor: Monitor) => {
    const window = windowFor(monitor);
    if (!window || isFailedWindow(failedWindowEnds, monitor.id, window.end)) return;
    try {
      await checkMonitor(context, monitor, window, start);
    } catch (err) {
      console.error(`[monitor] "${monitor.name}" check failed:`, err);
      await fail(context, monitor.id, window.end, err instanceof Error ? err.message : String(err));
    }
  };
  // A few workers share the queue, so many due monitors do not hit the data sources at once.
  const worker = async () => {
    for (let monitor = queue.shift(); monitor; monitor = queue.shift()) await runOne(monitor);
  };
  await Promise.all(Array.from({ length: CONFIG.monitorMaxConcurrentChecks }, worker));
}

export async function runDueMonitors(context: Context, start = startAgentSession): Promise<void> {
  const now = unixNow();
  await runMonitors(context, start, (m) => nextWindow(m.lastCheckedAt, m.frequencySeconds, now, ingestLagSeconds(m.query), incidentQuery(m.query) !== null));
}

/** Checks every enabled monitor now, whether a clock boundary passed or not. Only the iOS app calls it, when it opens. */
export async function runMonitorsNow(context: Context, start = startAgentSession): Promise<void> {
  const now = unixNow();
  await runMonitors(context, start, (m) => openWindow(m.lastCheckedAt, m.frequencySeconds, now, ingestLagSeconds(m.query), incidentQuery(m.query) !== null));
}

/**
 * Deletes data older than the retention time: finished monitor sessions (their run and memory rows go with them), firings no session or
 * issue points to, and sync delete markers. Chats the user started are never deleted. A phone that has not synced
 * for longer than the retention time can bring back a row deleted here.
 */
export async function pruneOldData(db: Db, now = unixNow()): Promise<void> {
  const cutoff = now - CONFIG.dataRetentionSeconds;
  await db.delete(chatSessions).where(and(
    eq(chatSessions.kind, SESSION_KIND.MONITOR),
    eq(chatSessions.status, "done"),
    lt(chatSessions.updatedAt, cutoff),
    notInArray(chatSessions.id, db.select({ id: alertIssues.sessionId }).from(alertIssues)),
  )).run();
  await db.delete(monitorTriggers).where(and(
    lt(monitorTriggers.triggeredAt, cutoff),
    or(isNull(monitorTriggers.sessionId), notInArray(monitorTriggers.sessionId, db.select({ id: chatSessions.id }).from(chatSessions))),
    notInArray(monitorTriggers.id, db.select({ id: alertIssues.triggerId }).from(alertIssues)),
  )).run();
  await db.delete(syncRows).where(and(eq(syncRows.deleted, 1), lt(syncRows.localAt, cutoff * 1000))).run();
}

/** True when a tick has nothing to do: no enabled monitor, no pending timer and no issue waiting on a run or a re-check. */
export async function isIdle(db: Db): Promise<boolean> {
  const row = await db.get<unknown[] | { busy: number }>(sql`SELECT
    EXISTS (SELECT 1 FROM monitors WHERE enabled = 1)
    OR EXISTS (SELECT 1 FROM session_timers WHERE fire_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM monitor_triggers WHERE status = 'pending')
    OR EXISTS (SELECT 1 FROM alert_issues WHERE state IN ('pending', 'watching')) AS busy`);
  return !(Array.isArray(row) ? row[0] : row?.busy);
}

export class MonitorScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  private started = false;
  private lastPrune = 0;

  constructor(private context: Context) {}

  start(): void {
    if (this.interval) return;
    console.log(`MonitorScheduler started (tick every ${CONFIG.monitorTickIntervalMs / 1000}s)`);
    this.interval = setInterval(() => this.tick(), CONFIG.monitorTickIntervalMs);
    // The iOS app restarts the scheduler on each return to the foreground; due monitors run then, not a tick later.
    // The first start waits one interval, so providers can connect before monitors and timers run.
    if (this.started) this.tick();
    this.started = true;
  }

  /** Checks every monitor now, then does the normal tick work. Waits for a tick in flight instead of dropping the check. */
  checkNow(): void {
    this.track((this.tickPromise ?? Promise.resolve()).then(() => this.run(runMonitorsNow)));
  }

  private tick(): void {
    if (this.tickPromise) return;
    this.track(this.run(runDueMonitors));
  }

  private track(work: Promise<void>): void {
    const promise: Promise<void> = work.finally(() => { if (this.tickPromise === promise) this.tickPromise = null; });
    this.tickPromise = promise;
  }

  private run(checkMonitors: (context: Context) => Promise<void>): Promise<void> {
    return isIdle(this.context.db)
      .then(async (idle) => {
        if (idle) return;
        await checkMonitors(this.context);
        await settlePendingFirings(this.context);
        await checkWatches(this.context);
        await fireDueTimers(this.context);
      })
      .then(() => this.pruneWhenDue())
      .catch((err) => console.error("MonitorScheduler tick error:", err));
  }

  private async pruneWhenDue(): Promise<void> {
    if (Date.now() - this.lastPrune < CONFIG.retentionSweepIntervalMs) return;
    this.lastPrune = Date.now();
    try {
      await pruneOldData(this.context.db);
    } catch (err) {
      console.error("[retention] Pruning failed:", err);
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.tickPromise) {
      console.log("MonitorScheduler waiting for current tick to finish...");
      await this.tickPromise;
    }
    console.log("MonitorScheduler stopped");
  }
}

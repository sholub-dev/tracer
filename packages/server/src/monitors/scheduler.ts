import { and, desc, eq, isNotNull, isNull, lt, notInArray, or } from "drizzle-orm";
import { SESSION_KIND, substituteWindow, unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { alertIssues, chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import type { Db } from "../db/driver.js";
import { startAgentSession } from "../agents/start-session.js";
import { sessionChanged } from "../lib/session-events.js";
import { CONFIG } from "../config.js";
import { evaluateCondition, extractGroups, parseCondition, sumGroups, type Group } from "./condition.js";
import { classifyGroups, pastSessions, pastSummary, readOutcome, readPastSessionTool, type PastSession, type TriggerGroup } from "./repeats.js";
import { withTimeout } from "./validate.js";
import { getTimezone } from "../lib/current-context.js";
import { monitorAlert, postSlack, readSlackConfig } from "../integrations/slack.js";
import { dismissAlertTool, reportAlertSummaryTool } from "./alert-summary.js";
import { fireDueTimers } from "./timers.js";
import {
  checkWatches, closeCounts, closedCheckPrompt, conditionOf, findIssues, forgetReports, incidentQuery, ingestLagSeconds, triageEnabled, issuesPrompt, pendingIssueIds, recordIssues,
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
): { start: number; end: number } | null {
  const end = Math.floor((now - lagSeconds) / frequencySeconds) * frequencySeconds;
  const start = lastCheckedAt ?? end - frequencySeconds;
  return end > start ? { start, end } : null;
}

/** A failed window is retried at the next clock boundary, not every tick; the next window still starts at lastCheckedAt. */
export function isFailedWindow(failedEnds: Map<string, number>, monitorId: string, windowEnd: number): boolean {
  return failedEnds.get(monitorId) === windowEnd;
}

const failedWindowEnds = new Map<string, number>();

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function groupLabel(g: Group): string {
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
    "If this looks like a past issue, its past cause is only a hypothesis. Read the most relevant past session, then check in this window that the same cause appears, starts before this firing and explains its groups and size. If it does, say which session; if any part differs, investigate fully.",
    `${dismissible ? "Unless you dismissed the alert, find" : "Find"} the root cause, or state where the data stops. Answer with report_finding as in any session.${slack ? " Right after it, before any visual, call report_alert_summary once with the alert details (after report_issue_status when that tool is listed). Slack posts the card and the details together. Do not repeat the card or the details as text." : ""}`,
  );
  return lines.join("\n");
}

/** Never throws: a Slack failure is only logged. */
async function notifySlack(
  context: Context, monitor: Monitor, triggeredAt: number, sessionId: string, triage?: Triage, outcome?: Awaited<ReturnType<typeof readOutcome>>,
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
        action: "Investigation failed (AI model error after retries). Issues it did not close stay open; Retry the session to triage them.",
        ping: true,
      });
      return;
    }
    const outcome = await readOutcome(context.db, sessionId);
    if (outcome.dismissed !== null) {
      console.log(`[monitor] "${monitor.name}" alert already closed, not posted: ${outcome.dismissed}`);
      return;
    }
    await notifySlack(context, monitor, triggeredAt, sessionId, await triageAfterRun(context, sessionId, found), outcome);
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
      ...(await readSlackConfig(db) ? { report_alert_summary: reportAlertSummaryTool() } : {}),
      ...(pending.length > 0 ? { report_issue_status: reportIssueStatusTool(db, pending), ...monitorIssueTools(context, pending) }
        : incidentQuery(monitor.query) ? { dismiss_alert: dismissAlertTool() } : {}),
    },
    onComplete: (outcome) => void completeFiring(context, monitor, trigger.triggeredAt, sessionId, undefined, outcome),
  };
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

async function latestSessionRunning(context: Context, monitorId: string): Promise<boolean> {
  const latest = await context.db
    .select({ sessionId: monitorTriggers.sessionId })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(monitorTriggers.sessionId)))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .limit(1)
    .get();
  return !!latest?.sessionId && context.activeStreams.has(latest.sessionId);
}

async function checkMonitor(context: Context, monitor: Monitor, window: { start: number; end: number }): Promise<void> {
  await context.providers.whenLoaded();
  await context.providers.reconnectDisconnected();
  const provider = context.providers.getProvider(monitor.provider);
  if (!provider?.connected) {
    // No backoff: cheap, and the provider can connect on a later check.
    await setStatus(context, monitor.id, { lastStatus: "error", lastError: `Provider ${monitor.provider} is not connected` });
    return;
  }
  if (await latestSessionRunning(context, monitor.id)) return;

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
  const value = sumGroups(extracted);
  if (!evaluateCondition(condition, value)) {
    await succeed(context, monitor.id, "ok", window.end);
    return;
  }

  const now = unixNow();
  // A true condition with no rows (e.g. "< 1") still needs one group to track.
  const groups = extracted.length > 0 ? extracted : [{ key: "", count: value }];
  // Re-read toggles: the user may have changed them while the query ran.
  const current = await context.db.select({ enabled: monitors.enabled, alertEnabled: monitors.alertEnabled })
    .from(monitors).where(eq(monitors.id, monitor.id)).get();
  if (!current?.enabled) return;
  // With alerts off, record the firing but never start a session.
  const alerting = current.alertEnabled !== 0;
  const classified = alerting
    ? await classifyGroups(context.db, monitor.id, groups, now)
    : groups.map((g) => ({ ...g, sessionId: null, repeat: false }));
  const sessionId = alerting ? crypto.randomUUID() : null;
  const triggerId = crypto.randomUUID();
  const past = alerting ? await pastSessions(context.db, monitor.id, classified.map((g) => g.key)) : [];
  const onIncidents = incidentQuery(monitor.query) !== null;
  const found: FoundIssues | null = alerting && await triageEnabled(context.db) && onIncidents ? await findIssues(context, monitor, window) : null;
  const openIssues = found && !("error" in found) ? found.open : [];
  const checkClosed = alerting && onIncidents && openIssues.length === 0;
  const slack = alerting && await readSlackConfig(context.db) !== null;
  const message = alerting
    ? buildMessage(monitor, value, window, classified, past, checkClosed ? closedCheckPrompt(found, slack) : issuesPrompt(openIssues, await closeCounts(context.db, monitor.id, sessionId!, openIssues.map((i) => ({ issueId: i.issueId, conditionName: conditionOf(i) }))), slack), checkClosed, slack)
    : "";
  try {
    // Insert first: the monitor_id FK fails if the monitor was deleted mid-check.
    await context.db.insert(monitorTriggers).values({
      id: triggerId,
      monitorId: monitor.id,
      triggeredAt: now,
      value,
      windowStart: window.start,
      windowEnd: window.end,
      status: alerting ? "investigating" : "muted",
      groups: JSON.stringify(classified.map((g) => (g.repeat ? g : { ...g, sessionId }))),
      sessionId,
    }).run();
  } catch (err) {
    console.warn(`[monitor] "${monitor.name}" trigger not recorded (monitor deleted?):`, err instanceof Error ? err.message : err);
    return;
  }

  if (sessionId && found && !("error" in found)) await recordIssues(context.db, { monitorId: monitor.id, triggerId, sessionId }, found);
  if (sessionId) {
    const started = await startAgentSession(context, {
      sessionId,
      kind: SESSION_KIND.MONITOR,
      title: sessionTitle(monitor.name, classified),
      message,
      tools: {
        read_past_session: readPastSessionTool(() => past),
        ...(slack ? { report_alert_summary: reportAlertSummaryTool() } : {}),
        ...(openIssues.length > 0 ? { report_issue_status: reportIssueStatusTool(context.db, openIssues.map((i) => i.issueId)), ...monitorIssueTools(context, openIssues.map((i) => i.issueId)) } : {}),
        ...(checkClosed ? { dismiss_alert: dismissAlertTool() } : {}),
      },
      onComplete: (outcome) => void completeFiring(context, monitor, now, sessionId, found, outcome),
    });
    if ("error" in started) {
      await context.db.delete(monitorTriggers).where(eq(monitorTriggers.id, triggerId)).run();
      await context.db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
      sessionChanged(sessionId);
      await fail(context, monitor.id, window.end, `Could not start session: ${started.error}`);
      return;
    }
  }

  console.log(`[monitor] "${monitor.name}" triggered (value ${value}${sessionId ? `, session ${sessionId}` : ", alerts off"})`);
  await succeed(context, monitor.id, "triggered", window.end);
}

export async function runDueMonitors(context: Context): Promise<void> {
  const enabled = await context.db.select().from(monitors).where(eq(monitors.enabled, 1)).all();
  const now = unixNow();
  const queue = [...enabled];
  const runOne = async (monitor: Monitor) => {
    const window = nextWindow(monitor.lastCheckedAt, monitor.frequencySeconds, now, ingestLagSeconds(monitor.query));
    if (!window || isFailedWindow(failedWindowEnds, monitor.id, window.end)) return;
    try {
      await checkMonitor(context, monitor, window);
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

/**
 * Deletes firings older than the retention time that no session or issue points to. Session, run and memory rows stay:
 * the session pages show them. Sync delete markers stay too: this computer keeps no record of what each phone received.
 */
export async function pruneOldData(db: Db, now = unixNow()): Promise<void> {
  const cutoff = now - CONFIG.dataRetentionSeconds;
  await db.delete(monitorTriggers).where(and(
    lt(monitorTriggers.triggeredAt, cutoff),
    or(isNull(monitorTriggers.sessionId), notInArray(monitorTriggers.sessionId, db.select({ id: chatSessions.id }).from(chatSessions))),
    notInArray(monitorTriggers.id, db.select({ id: alertIssues.triggerId }).from(alertIssues)),
  )).run();

}

let lastPrune = 0;

async function pruneWhenDue(db: Db): Promise<void> {
  if (Date.now() - lastPrune < CONFIG.retentionSweepIntervalMs) return;
  lastPrune = Date.now();
  try {
    await pruneOldData(db);
  } catch (err) {
    console.error("[retention] Pruning failed:", err);
  }
}

export class MonitorScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  private started = false;

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

  private tick(): void {
    if (this.tickPromise) return;
    this.tickPromise = runDueMonitors(this.context)
      .then(() => checkWatches(this.context))
      .then(() => fireDueTimers(this.context))
      .then(() => pruneWhenDue(this.context.db))
      .catch((err) => console.error("MonitorScheduler tick error:", err))
      .finally(() => { this.tickPromise = null; });
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

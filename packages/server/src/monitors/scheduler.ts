import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { SESSION_KIND, substituteWindow, unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { startAgentSession } from "../agents/start-session.js";
import { sessionChanged } from "../lib/session-events.js";
import { CONFIG } from "../config.js";
import { evaluateCondition, extractGroups, parseCondition, sumGroups, type Group } from "./condition.js";
import { classifyGroups, pastSessions, readAnalysis, readPastSessionTool, type PastSession, type TriggerGroup } from "./repeats.js";
import { withTimeout } from "./validate.js";
import { getTimezone } from "../lib/current-context.js";
import { monitorAlert, parseVerdict, postSlack, readSlackConfig } from "../integrations/slack.js";
import { fireDueTimers } from "./timers.js";
import {
  checkWatches, findIssues, forgetReports, incidentQuery, ingestLagSeconds, triageEnabled, issuesPrompt, pendingIssueIds, recordIssues,
  reportIssueStatusTool, triageAfterRun, type FoundIssues, type Triage,
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

function buildMessage(
  monitor: Monitor,
  value: number,
  window: { start: number; end: number },
  classified: TriggerGroup[],
  past: PastSession[],
  triageLines: string[] = [],
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
      lines.push(`- ${iso(p.triggeredAt)} groups: ${p.keys.join(", ") || "none"} session ${p.sessionId}: ${parseVerdict(p.analysis).summary || "no summary"}`);
    }
  }
  lines.push(...triageLines);
  lines.push(
    "",
    "If this looks like a past issue, read the most relevant past session, confirm with the fewest queries possible and say which one; otherwise investigate fully.",
    "Find the root cause and end with a short summary. Its last lines must be exactly these labels, in this order, each on one line.",
    "Use only facts from query results; write \"unknown\" when the data does not show it, never guess. Name endpoints by route pattern such as /loans/{id}, never raw URLs or IDs. No personal data such as emails, names or account numbers. Never suggest fixes or actions. Never add counts across endpoints. These lines must stand alone: facts only, never mention sessions, session ids or Tracer.",
    "Severity: <critical|high|medium|low> (critical: outage or users blocked; high: a key flow degraded; medium: limited impact; low: noise or no user impact)",
    "TL;DR: <the actual issue and its proven root cause with the key number, not a restatement of the monitor; say \"cause not confirmed\" if it is not>",
    "Policy: <the alert policy or condition that fired>",
    "Started: <the first bad minute in the data, with time zone>",
    "Status: <one of: stopped (last error at <time>); ongoing (errors in the latest minutes up to now); recurring (the repeat pattern the data shows, e.g. every hour since 06:00)>. Check the data up to the current time.",
    "Issue: <service> | <endpoint> | <count> × <error class and code> (<error rate>) | <what the user sees> | <user journey step, or none (background)>",
    "(one Issue line per endpoint, at most 5, largest first)",
    "Seen before: <yes or no; the date and time it happened before, and whether the cause was the same>",
  );
  return lines.join("\n");
}

/** Never throws: a Slack failure is only logged. */
async function notifySlack(context: Context, monitor: Monitor, triggeredAt: number, sessionId: string, triage?: Triage): Promise<void> {
  let error: string;
  try {
    const slack = readSlackConfig(context.db);
    if (!slack) return;
    const analysis = readAnalysis(context.db, sessionId);
    const result = await postSlack(slack.webhookUrl, monitorAlert({
      name: monitor.name,
      triggeredAt,
      analysis,
      timeZone: getTimezone(context.db),
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
function claimFiring(context: Context, sessionId: string, failed: boolean): boolean {
  const unreported = failed ? isNull(monitorTriggers.reported) : or(isNull(monitorTriggers.reported), eq(monitorTriggers.reported, "failed"));
  return context.db.update(monitorTriggers).set({ reported: failed ? "failed" : "done" })
    .where(and(eq(monitorTriggers.sessionId, sessionId), unreported))
    .run().changes > 0;
}

/** Triage and the Slack post after a firing's run; never throws. Without `found` (a re-run) triage uses the recorded issues. */
async function completeFiring(
  context: Context, monitor: Monitor, triggeredAt: number, sessionId: string, found: FoundIssues | null | undefined, { error }: RunOutcome,
): Promise<void> {
  try {
    if (!claimFiring(context, sessionId, error !== undefined)) return;
    if (error !== undefined) {
      // Issues stay pending so a Retry can still triage them; the stale sweep leaves them open after an hour.
      forgetReports(context.db, sessionId);
      // The provider's error text stays in the local log; Slack gets a fixed line.
      console.warn(`[monitor] "${monitor.name}" investigation failed:`, error);
      await notifySlack(context, monitor, triggeredAt, sessionId, {
        action: "Investigation failed (AI model error after retries). New Relic issues left open; Retry the session to triage them.",
        ping: true,
      });
      return;
    }
    await notifySlack(context, monitor, triggeredAt, sessionId, await triageAfterRun(context, sessionId, found));
  } catch (err) {
    console.error(`[monitor] "${monitor.name}" completion failed:`, err instanceof Error ? err.message : err);
  }
}

/** The tools and completion of a firing's session for a re-run such as Retry; null once its run was reported. */
export function firingRerun(context: Context, sessionId: string): { tools: Record<string, unknown>; onComplete: (outcome: RunOutcome) => void } | null {
  const { db } = context;
  const trigger = db.select({ monitorId: monitorTriggers.monitorId, triggeredAt: monitorTriggers.triggeredAt, reported: monitorTriggers.reported })
    .from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
  if (!trigger || trigger.reported === "done") return null;
  const monitor = db.select().from(monitors).where(eq(monitors.id, trigger.monitorId)).get();
  if (!monitor) return null;
  const pending = pendingIssueIds(db, sessionId);
  return {
    tools: pending.length > 0 ? { report_issue_status: reportIssueStatusTool(db, pending) } : {},
    onComplete: (outcome) => void completeFiring(context, monitor, trigger.triggeredAt, sessionId, undefined, outcome),
  };
}

function setStatus(context: Context, monitorId: string, fields: Partial<Pick<Monitor, "lastStatus" | "lastError" | "lastCheckedAt">>): void {
  context.db.update(monitors).set(fields).where(eq(monitors.id, monitorId)).run();
}

function fail(context: Context, monitorId: string, windowEnd: number, message: string): void {
  failedWindowEnds.set(monitorId, windowEnd);
  setStatus(context, monitorId, { lastStatus: "error", lastError: message });
}

function succeed(context: Context, monitorId: string, lastStatus: "ok" | "triggered", windowEnd: number): void {
  failedWindowEnds.delete(monitorId);
  setStatus(context, monitorId, { lastStatus, lastError: null, lastCheckedAt: windowEnd });
}

function latestSessionRunning(context: Context, monitorId: string): boolean {
  const latest = context.db
    .select({ sessionId: monitorTriggers.sessionId })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(monitorTriggers.sessionId)))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .limit(1)
    .get();
  return !!latest?.sessionId && context.activeStreams.has(latest.sessionId);
}

async function checkMonitor(context: Context, monitor: Monitor, window: { start: number; end: number }): Promise<void> {
  const provider = context.providers.getProvider(monitor.provider);
  if (!provider?.connected) {
    // No backoff: cheap, and providers connect a few seconds after startup.
    setStatus(context, monitor.id, { lastStatus: "error", lastError: `Provider ${monitor.provider} is not connected` });
    return;
  }
  if (latestSessionRunning(context, monitor.id)) return;

  const condition = parseCondition(monitor.condition);
  if (!condition) {
    fail(context, monitor.id, window.end, `Invalid condition "${monitor.condition}"`);
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
    fail(context, monitor.id, window.end, message);
    return;
  }

  const extracted = extractGroups(result, monitor.provider);
  const value = sumGroups(extracted);
  if (!evaluateCondition(condition, value)) {
    succeed(context, monitor.id, "ok", window.end);
    return;
  }

  const now = unixNow();
  // A true condition with no rows (e.g. "< 1") still needs one group to track.
  const groups = extracted.length > 0 ? extracted : [{ key: "", count: value }];
  // Re-read toggles: the user may have changed them while the query ran.
  const current = context.db.select({ enabled: monitors.enabled, alertEnabled: monitors.alertEnabled })
    .from(monitors).where(eq(monitors.id, monitor.id)).get();
  if (!current?.enabled) return;
  // With alerts off, record the firing but never start a session.
  const alerting = current.alertEnabled !== 0;
  const classified = alerting
    ? classifyGroups(context.db, monitor.id, groups, now)
    : groups.map((g) => ({ ...g, sessionId: null, repeat: false }));
  const sessionId = alerting ? crypto.randomUUID() : null;
  const triggerId = crypto.randomUUID();
  const past = alerting ? pastSessions(context.db, monitor.id, classified.map((g) => g.key)) : [];
  const found: FoundIssues | null = alerting && triageEnabled(context.db) && incidentQuery(monitor.query) ? await findIssues(context, monitor, window) : null;
  const openIssues = found && !("error" in found) ? found.open : [];
  const message = alerting ? buildMessage(monitor, value, window, classified, past, issuesPrompt(openIssues)) : "";
  try {
    // Insert first: the monitor_id FK fails if the monitor was deleted mid-check.
    context.db.insert(monitorTriggers).values({
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

  if (sessionId && found && !("error" in found)) recordIssues(context.db, { monitorId: monitor.id, triggerId, sessionId }, found);
  if (sessionId) {
    const started = await startAgentSession(context, {
      sessionId,
      kind: SESSION_KIND.MONITOR,
      title: sessionTitle(monitor.name, classified),
      message,
      tools: {
        read_past_session: readPastSessionTool(() => past),
        ...(openIssues.length > 0 ? { report_issue_status: reportIssueStatusTool(context.db, openIssues.map((i) => i.issueId)) } : {}),
      },
      onComplete: (outcome) => void completeFiring(context, monitor, now, sessionId, found, outcome),
    });
    if ("error" in started) {
      context.db.delete(monitorTriggers).where(eq(monitorTriggers.id, triggerId)).run();
      context.db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
      sessionChanged(sessionId);
      fail(context, monitor.id, window.end, `Could not start session: ${started.error}`);
      return;
    }
  }

  console.log(`[monitor] "${monitor.name}" triggered (value ${value}${sessionId ? `, session ${sessionId}` : ", alerts off"})`);
  succeed(context, monitor.id, "triggered", window.end);
}

export async function runDueMonitors(context: Context): Promise<void> {
  const enabled = context.db.select().from(monitors).where(eq(monitors.enabled, 1)).all();
  const now = unixNow();
  await Promise.all(enabled.map(async (monitor) => {
    const window = nextWindow(monitor.lastCheckedAt, monitor.frequencySeconds, now, ingestLagSeconds(monitor.query));
    if (!window || isFailedWindow(failedWindowEnds, monitor.id, window.end)) return;
    try {
      await checkMonitor(context, monitor, window);
    } catch (err) {
      console.error(`[monitor] "${monitor.name}" check failed:`, err);
      fail(context, monitor.id, window.end, err instanceof Error ? err.message : String(err));
    }
  }));
}

export class MonitorScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;

  constructor(private context: Context) {}

  start(): void {
    if (this.interval) return;
    console.log(`MonitorScheduler started (tick every ${CONFIG.monitorTickIntervalMs / 1000}s)`);
    this.interval = setInterval(() => {
      if (this.tickPromise) return;
      this.tickPromise = runDueMonitors(this.context)
        .then(() => checkWatches(this.context))
        .then(() => fireDueTimers(this.context))
        .catch((err) => console.error("MonitorScheduler tick error:", err))
        .finally(() => { this.tickPromise = null; });
    }, CONFIG.monitorTickIntervalMs);
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

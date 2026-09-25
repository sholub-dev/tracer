import { and, desc, eq, isNotNull } from "drizzle-orm";
import { SESSION_KIND, substituteWindow, unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { startAgentSession } from "../agents/start-session.js";
import { CONFIG } from "../config.js";
import { evaluateCondition, extractGroups, parseCondition, sumGroups, type Group } from "./condition.js";
import { classifyGroups, pastSummaries, type TriggerGroup } from "./repeats.js";
import { withTimeout } from "./validate.js";
import { extractAnalysis } from "../agents/analysis.js";
import { getTimezone } from "../lib/current-context.js";
import { monitorAlertText, postSlack, readSlackConfig } from "../integrations/slack.js";

type Monitor = typeof monitors.$inferSelect;

/** Runs on clock boundaries (every 5 min at :00, :05, ...); the window ends `lag` before the boundary. */
export function nextWindow(
  lastCheckedAt: number | null,
  frequencySeconds: number,
  now: number,
  lagSeconds = CONFIG.monitorIngestLagSeconds,
): { start: number; end: number } | null {
  const end = Math.floor(now / frequencySeconds) * frequencySeconds - lagSeconds;
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
  const keys = classified.filter((g) => !g.repeat && g.key).map((g) => g.key).join(", ");
  const title = keys ? `${name}: ${keys}` : name;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function buildMessage(
  context: Context,
  monitor: Monitor,
  value: number,
  window: { start: number; end: number },
  classified: TriggerGroup[],
): string {
  const fresh = classified.filter((g) => !g.repeat);
  const repeats = classified.filter((g) => g.repeat);
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
    "New groups to investigate:",
    ...fresh.map((g) => `- ${groupLabel(g)}`),
  ];
  if (repeats.length > 0) {
    lines.push("", "Already investigated recently (skip these):", ...repeats.map((g) => `- ${groupLabel(g)}`));
  }
  const past = pastSummaries(context.db, monitor.id, 3);
  if (past.length > 0) {
    lines.push("", "Past investigations of this monitor:");
    for (const p of past) {
      const keys = p.keys.filter(Boolean).join(", ");
      lines.push("", `### ${iso(p.triggeredAt)}${keys ? ` (groups: ${keys})` : ""} session ${p.sessionId}`, p.summary);
    }
  }
  lines.push(
    "",
    "If this matches a past issue, confirm with the fewest queries possible and say which one; otherwise investigate fully.",
    "Find the root cause and end with a short summary. Its last two lines must be exactly:",
    "Severity: <critical|high|medium|low> (critical: outage or users blocked; high: a key flow degraded; medium: limited impact; low: noise or no user impact)",
    "TL;DR: <one sentence: the actual issue and its root cause, not a restatement of the monitor; no personal data such as emails, names or account numbers>",
  );
  return lines.join("\n");
}

/** Never throws: a Slack failure is only logged. */
async function notifySlack(context: Context, monitor: Monitor, value: number, classified: TriggerGroup[], triggeredAt: number, sessionId: string): Promise<void> {
  let error: string;
  try {
    const slack = readSlackConfig(context.db);
    if (!slack) return;
    const row = context.db.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
    let analysis = "";
    try {
      analysis = row ? extractAnalysis(JSON.parse(row.messages)).analysis : "";
    } catch { /* post without a summary */ }
    const result = await postSlack(slack.webhookUrl, monitorAlertText({
      name: monitor.name,
      condition: monitor.condition,
      value,
      groups: classified.filter((g) => !g.repeat).map((g) => g.key),
      triggeredAt,
      analysis,
      timeZone: getTimezone(context.db),
      mentions: slack.mentions,
    }));
    if (!("error" in result)) return;
    error = result.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  console.warn(`[monitor] "${monitor.name}" Slack post failed:`, error);
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
  const hasNew = alerting && classified.some((g) => !g.repeat);

  const sessionId = hasNew ? crypto.randomUUID() : null;
  const triggerId = crypto.randomUUID();
  const message = sessionId ? buildMessage(context, monitor, value, window, classified) : "";
  try {
    // Insert first: the monitor_id FK fails if the monitor was deleted mid-check.
    context.db.insert(monitorTriggers).values({
      id: triggerId,
      monitorId: monitor.id,
      triggeredAt: now,
      value,
      windowStart: window.start,
      windowEnd: window.end,
      status: !alerting ? "muted" : hasNew ? "investigating" : "repeat",
      groups: JSON.stringify(classified.map((g) => (g.repeat ? g : { ...g, sessionId }))),
      sessionId,
    }).run();
  } catch (err) {
    console.warn(`[monitor] "${monitor.name}" trigger not recorded (monitor deleted?):`, err instanceof Error ? err.message : err);
    return;
  }

  if (sessionId) {
    const started = await startAgentSession(context, {
      sessionId,
      kind: SESSION_KIND.MONITOR,
      title: sessionTitle(monitor.name, classified),
      message,
      onComplete: () => void notifySlack(context, monitor, value, classified, now, sessionId),
    });
    if ("error" in started) {
      context.db.delete(monitorTriggers).where(eq(monitorTriggers.id, triggerId)).run();
      context.db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
      fail(context, monitor.id, window.end, `Could not start session: ${started.error}`);
      return;
    }
  }

  console.log(`[monitor] "${monitor.name}" triggered (value ${value}${hasNew ? `, session ${sessionId}` : alerting ? ", repeat" : ", alerts off"})`);
  succeed(context, monitor.id, "triggered", window.end);
}

export async function runDueMonitors(context: Context): Promise<void> {
  const enabled = context.db.select().from(monitors).where(eq(monitors.enabled, 1)).all();
  const now = unixNow();
  await Promise.all(enabled.map(async (monitor) => {
    const window = nextWindow(monitor.lastCheckedAt, monitor.frequencySeconds, now);
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

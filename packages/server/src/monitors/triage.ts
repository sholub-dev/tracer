import { and, countDistinct, eq, gte, inArray, lt, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { tool, type Tool } from "ai";
import { SESSION_KIND, substituteWindow, unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import type { Db } from "../db/client.js";
import { alertIssues, chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { CONFIG, SETTINGS_KEYS } from "../config.js";
import { readAppSetting } from "../db/config-reader.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import type { AiIssue } from "../providers/newrelic/nerdgraph.client.js";
import { startAgentSession } from "../agents/start-session.js";
import { sessionChanged } from "../lib/session-events.js";
import { clip, parseVerdict, postSlack, readSlackConfig, triageUpdate } from "../integrations/slack.js";
import { readAnalysis } from "./repeats.js";
import { withTimeout } from "./validate.js";

const ISSUE_STATUSES = ["stopped", "ongoing", "recurring", "unknown"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

type Monitor = typeof monitors.$inferSelect;
type IssueRow = typeof alertIssues.$inferSelect;
export type Triage = { action: string; ping: boolean };
export type FoundIssues = { open: AiIssue[]; closed: AiIssue[]; tracked: number } | { error: string };

// Issues can open hours before the incident event that fired the monitor.
const ISSUE_LOOKBACK_SECONDS = 6 * 3600;
const BUSY_RETRY_SECONDS = 60;
const PENDING_STALE_SECONDS = 3600;
const TITLE_MAX_CHARS = 150;
const TERMINAL_STATES = ["closed", "nr_closed", "left_open"];

/** Settings switch, off by default: when off, monitors only post their analysis. */
export function triageEnabled(db: Db): boolean {
  return readAppSetting<boolean>(db, SETTINGS_KEYS.alertTriage) === true;
}

const SELECT_FROM_INCIDENT = /^\s*SELECT\s+[\s\S]+?\s+FROM\s+NrAiIncident\b/i;

/** The monitor query listing its incident, policy and condition ids; null when it is not on NrAiIncident. */
export function incidentQuery(query: string): string | null {
  if (!SELECT_FROM_INCIDENT.test(query)) return null;
  return query
    .replace(SELECT_FROM_INCIDENT, "SELECT uniques(incidentId), uniques(policyId), uniques(conditionId) FROM NrAiIncident")
    .replace(/\s+TIMESERIES(\s+(\d+\s+[a-z]+|AUTO|MAX))?(\s+SLIDE\s+BY\s+(\d+\s+[a-z]+|AUTO|MAX))?\b/i, "");
}

export function incidentRefs(rows: unknown): { incidentIds: Set<string>; policyIds: number[]; conditionIds: number[] } {
  const incidentIds = new Set<string>();
  const policyIds = new Set<number>();
  const conditionIds = new Set<number>();
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const ints = (v: unknown, into: Set<number>) => { for (const id of list(v)) if (Number.isInteger(Number(id))) into.add(Number(id)); };
  for (const row of list(rows) as Record<string, unknown>[]) {
    for (const id of list(row["uniques.incidentId"])) incidentIds.add(String(id));
    ints(row["uniques.policyId"], policyIds);
    ints(row["uniques.conditionId"], conditionIds);
  }
  return { incidentIds, policyIds: [...policyIds], conditionIds: [...conditionIds] };
}

function newRelic(context: Context): NewRelicProvider | null {
  const provider = context.providers.getProvider("newrelic");
  return provider instanceof NewRelicProvider && provider.connected ? provider : null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const titleOf = (i: AiIssue) => i.title?.[0] ?? i.issueId;
const conditionOf = (i: AiIssue) => i.conditionName?.[0] ?? "";

/** The firing's NR issues not handled by an earlier firing, split into open and already closed. */
export async function findIssues(context: Context, monitor: Monitor, window: { start: number; end: number }): Promise<FoundIssues> {
  const nr = newRelic(context);
  if (!nr) return { error: "New Relic is not connected" };
  const query = incidentQuery(monitor.query);
  if (!query) return { error: "The monitor query is not on NrAiIncident" };
  try {
    const { incidentIds, policyIds, conditionIds } = incidentRefs(await withTimeout(
      nr.executeRawQuery(substituteWindow("newrelic", query, window.start, window.end)), CONFIG.monitorQueryTimeoutMs, "incident query",
    ));
    if (policyIds.length === 0) return { open: [], closed: [], tracked: 0 };
    const issues = await withTimeout(
      nr.aiIssues({ policyIds, ...(conditionIds.length > 0 ? { conditionIds } : {}) }, (window.start - ISSUE_LOOKBACK_SECONDS) * 1000, Date.now()), CONFIG.monitorQueryTimeoutMs, "New Relic issues",
    );
    const matched = new Map(issues.filter((i) => (i.incidentIds ?? []).some((id) => incidentIds.has(id))).map((i) => [i.issueId, i]));
    const handled = matched.size === 0 ? [] : context.db.select({ id: alertIssues.issueId }).from(alertIssues)
      .where(inArray(alertIssues.issueId, [...matched.keys()])).all();
    for (const { id } of handled) matched.delete(id);
    const fresh = [...matched.values()];
    return { open: fresh.filter((i) => i.state !== "CLOSED"), closed: fresh.filter((i) => i.state === "CLOSED"), tracked: handled.length };
  } catch (err) {
    return { error: errorText(err) };
  }
}

export function recordIssues(db: Db, ids: { monitorId: string; triggerId: string; sessionId: string }, found: { open: AiIssue[]; closed: AiIssue[] }): void {
  const now = unixNow();
  const rows = [...found.open.map((i) => [i, "pending"] as const), ...found.closed.map((i) => [i, "nr_closed"] as const)]
    .map(([i, state]) => ({
      ...ids, issueId: i.issueId, conditionName: conditionOf(i), title: titleOf(i), state, createdAt: now, updatedAt: now,
    }));
  if (rows.length > 0) db.insert(alertIssues).values(rows).onConflictDoNothing().run();
}

const issueList = (issues: { issueId: string; conditionName: string; title: string }[]) =>
  issues.map((i) => `- ${i.issueId}: ${i.conditionName || "unknown condition"} | ${i.title}`);

const REPORT_INSTRUCTION = "call report_issue_status once with the severity and, for each issue id above, its status: stopped, ongoing, recurring or unknown.";

export function issuesPrompt(open: AiIssue[]): string[] {
  if (open.length === 0) return [];
  return [
    "",
    "New Relic issues of this firing that are still open:",
    ...issueList(open.map((i) => ({ issueId: i.issueId, conditionName: conditionOf(i), title: titleOf(i) }))),
    `Before the closing lines, ${REPORT_INSTRUCTION} Base it on the data up to now.`,
  ];
}

export function recheckMessage(monitorName: string, issues: IssueRow[], now: number, finding: string): string {
  return [
    `Monitor "${monitorName}" re-check at ${new Date(now * 1000).toISOString()}.`,
    ...(finding ? [`Original finding: ${finding}`] : []),
    "These New Relic issues are still open:",
    ...issueList(issues),
    `Look at the last 15 minutes only, with the fewest queries possible. Then ${REPORT_INSTRUCTION}`,
    "End with one line: Status: <stopped (last error at <time>); ongoing; recurring (the pattern)>. Facts only, never suggest fixes or actions.",
  ].join("\n");
}

type IssueReport = { severity: "critical" | "high" | "medium" | "low"; issues: { issueId: string; status: IssueStatus }[] };

export function reportIssueStatusTool(db: Db, allowedIds: string[]): Tool<IssueReport, { error: string } | { recorded: number }> {
  return tool({
    description: "Report the severity and the status of each New Relic issue listed in the prompt. It only records the report and never changes New Relic.",
    inputSchema: z.object({
      severity: z.enum(["critical", "high", "medium", "low"]),
      issues: z.array(z.object({ issueId: z.string(), status: z.enum(ISSUE_STATUSES) })),
    }),
    execute: async ({ severity, issues }) => {
      const allowed = new Set(allowedIds);
      const rejected = issues.filter((i) => !allowed.has(i.issueId)).map((i) => i.issueId);
      if (rejected.length > 0) return { error: `Not issues of this firing: ${rejected.join(", ")}. Use only the listed issue ids.` };
      const now = unixNow();
      for (const i of issues) {
        db.update(alertIssues).set({ severity, verdict: i.status, updatedAt: now })
          .where(eq(alertIssues.issueId, i.issueId)).run();
      }
      return { recorded: issues.length };
    },
  });
}

export interface DecideInput {
  verdict: IssueStatus;
  severity: string | null;
  nrState: "open" | "closed" | "unknown";
  /** Earlier firings of the same monitor whose issue on this condition Tracer closed in the last 24h. */
  recentCloses: number;
  watchExpired: boolean;
  recheck: boolean;
}

export type Decision = { outcome: "close" | "watching" | "nr_closed" | "left_open"; ping: boolean; reason?: string };

export function decide(i: DecideInput): Decision {
  if (i.nrState === "closed") return { outcome: "nr_closed", ping: false };
  if (i.verdict === "unknown") return { outcome: "left_open", ping: true, reason: "status unknown" };
  if (i.verdict !== "stopped") {
    if (i.watchExpired) return { outcome: "left_open", ping: true, reason: "still ongoing after 24h" };
    return { outcome: "watching", ping: !i.recheck };
  }
  if (i.nrState === "unknown") return { outcome: "left_open", ping: true, reason: "could not read its New Relic state" };
  if (i.recentCloses >= CONFIG.triageLoopMax) {
    return { outcome: "left_open", ping: true, reason: `closed ${i.recentCloses} times in 24h and it keeps coming back` };
  }
  return { outcome: "close", ping: !i.recheck && (i.severity === "high" || i.severity === "critical") };
}

function actionLine(state: string, title: string, reason?: string): string {
  const labels: Record<string, string> = {
    closed: "Acked and closed in New Relic",
    watching: `Still ongoing, left open, re-checking every ${CONFIG.triageRecheckSeconds / 60} min`,
    nr_closed: "Already closed in New Relic",
  };
  const label = labels[state] ?? `Left open (${reason ?? "unknown"})`;
  return `${label}: ${clip(title, TITLE_MAX_CHARS)}`;
}

// Counts earlier firings, not sibling issues of this one.
function recentCloses(db: Db, row: IssueRow, now: number): number {
  return db.select({ n: countDistinct(alertIssues.sessionId) }).from(alertIssues).where(and(
    eq(alertIssues.monitorId, row.monitorId),
    eq(alertIssues.conditionName, row.conditionName),
    eq(alertIssues.state, "closed"),
    gte(alertIssues.updatedAt, now - CONFIG.triageLoopWindowSeconds),
    ne(alertIssues.sessionId, row.sessionId),
  )).get()?.n ?? 0;
}

async function freshStates(context: Context, rows: IssueRow[]): Promise<Map<string, AiIssue> | null> {
  const nr = newRelic(context);
  if (!nr || rows.length === 0) return null;
  const trigger = context.db.select({ windowStart: monitorTriggers.windowStart }).from(monitorTriggers)
    .where(eq(monitorTriggers.id, rows[0].triggerId)).get();
  const since = (trigger?.windowStart ?? rows[0].createdAt) - ISSUE_LOOKBACK_SECONDS;
  try {
    const issues = await nr.aiIssues({ ids: rows.map((r) => r.issueId) }, since * 1000, Date.now());
    return new Map(issues.map((i) => [i.issueId, i]));
  } catch (err) {
    console.warn("[triage] issue state check failed:", errorText(err));
    return null;
  }
}

// Ack first so New Relic and JSM record it as handled, then close; a failed ack does not block the close.
async function ackThenClose(nr: NewRelicProvider, issueId: string): Promise<{ ok: true } | { error: string }> {
  const ack = await nr.ackIssue(issueId);
  if ("error" in ack) console.warn(`[triage] ack of ${issueId} failed:`, ack.error);
  return nr.resolveIssue(issueId);
}

/** Decides and acts on the session's pending issues; returns the Slack action and whether to ping. */
export async function applyTriage(context: Context, sessionId: string, recheck: boolean): Promise<Triage | null> {
  const { db } = context;
  const rows = db.select().from(alertIssues)
    .where(and(eq(alertIssues.sessionId, sessionId), inArray(alertIssues.state, recheck ? ["pending"] : ["pending", "nr_closed"]))).all();
  if (rows.length === 0) return null;
  const enabled = triageEnabled(db);
  const pending = rows.filter((r) => r.state === "pending");
  const fresh = await freshStates(context, pending);
  const lines: string[] = [];
  let ping = false;
  for (const row of rows) {
    if (row.state === "nr_closed") {
      lines.push(actionLine("nr_closed", row.title));
      continue;
    }
    const now = unixNow();
    const nrIssue = fresh?.get(row.issueId);
    let d: Decision = !enabled
      ? { outcome: "left_open", ping: true, reason: "triage turned off" }
      : decide({
        verdict: (row.verdict ?? "unknown") as IssueStatus,
        severity: row.severity,
        nrState: !nrIssue ? "unknown" : nrIssue.state === "CLOSED" ? "closed" : "open",
        recentCloses: recentCloses(db, row, now),
        watchExpired: row.watchUntil !== null && now >= row.watchUntil,
        recheck,
      });
    let state: string = d.outcome;
    let lastError: string | null = null;
    if (d.outcome === "close") {
      const nr = newRelic(context);
      const result = nr ? await ackThenClose(nr, row.issueId) : { error: "New Relic is not connected" };
      state = "closed";
      if ("error" in result) {
        state = "left_open";
        lastError = result.error;
        d = { outcome: "left_open", ping: true, reason: `close failed: ${result.error}` };
      }
    }
    const watching = state === "watching";
    db.update(alertIssues).set({
      state,
      lastError,
      watchUntil: watching ? (row.watchUntil ?? now + CONFIG.triageWatchMaxSeconds) : row.watchUntil,
      nextCheckAt: watching ? now + CONFIG.triageRecheckSeconds : null,
      updatedAt: now,
    }).where(eq(alertIssues.issueId, row.issueId)).run();
    ping ||= d.ping;
    if (!(recheck && watching)) lines.push(actionLine(state, row.title, d.reason));
  }
  return { action: lines.join("; "), ping };
}

/** The Slack action for a finished firing investigation; never throws. */
export async function triageAfterRun(context: Context, sessionId: string, found: FoundIssues): Promise<Triage> {
  if ("error" in found) return { action: `Triage skipped: could not read the New Relic issues (${found.error})`, ping: true };
  try {
    const triage = await applyTriage(context, sessionId, false);
    if (triage) return triage;
    // Found issues with no rows here were recorded first by a concurrent firing.
    return found.tracked + found.open.length + found.closed.length > 0
      ? { action: "Already tracked from an earlier alert", ping: false }
      : { action: "Triage skipped: no New Relic issue matched this firing", ping: true };
  } catch (err) {
    console.error("[triage] failed:", errorText(err));
    return { action: `Triage failed: ${errorText(err)}`, ping: true };
  }
}

async function postUpdate(context: Context, monitorName: string, triage: Triage | null): Promise<void> {
  if (!triage?.action) return;
  try {
    const slack = readSlackConfig(context.db);
    if (!slack) return;
    const result = await postSlack(slack.webhookUrl, triageUpdate({ name: monitorName, ...triage, mentions: slack.mentions }));
    if ("error" in result) console.warn(`[triage] "${monitorName}" Slack post failed:`, result.error);
  } catch (err) {
    console.warn(`[triage] "${monitorName}" Slack post failed:`, errorText(err));
  }
}

function setRows(db: Db, rows: IssueRow[], fields: Partial<IssueRow>): void {
  if (rows.length === 0) return;
  db.update(alertIssues).set({ ...fields, updatedAt: unixNow() }).where(inArray(alertIssues.issueId, rows.map((r) => r.issueId))).run();
}

async function recheckSession(context: Context, sessionId: string, rows: IssueRow[], now: number): Promise<void> {
  const { db } = context;
  const monitor = db.select().from(monitors).where(eq(monitors.id, rows[0].monitorId)).get();
  if (!monitor) return;
  const lines: string[] = [];
  let ping = false;
  const leaveOpen = (list: IssueRow[], reason: string) => {
    setRows(db, list, { state: "left_open", nextCheckAt: null });
    lines.push(...list.map((r) => actionLine("left_open", r.title, reason)));
    ping ||= list.length > 0;
  };

  let active = rows;
  // Stop when the firing's session was deleted; muted monitors never start sessions.
  const stopReason = !triageEnabled(db) ? "triage turned off"
    : !monitor.enabled || monitor.alertEnabled === 0 ? "monitor or its alerts turned off"
    : !db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get() ? "its session was deleted"
    : null;
  if (stopReason) {
    leaveOpen(active, `stopped watching, ${stopReason}`);
    active = [];
  }
  leaveOpen(active.filter((r) => r.watchUntil !== null && now >= r.watchUntil), "still ongoing after 24h");
  active = active.filter((r) => r.watchUntil === null || now < r.watchUntil);

  if (active.length > 0 && active.some((r) => r.recheckSessionId && context.activeStreams.has(r.recheckSessionId))) {
    setRows(db, active, { nextCheckAt: now + BUSY_RETRY_SECONDS });
    active = [];
  }
  // Cheap NR check first: the agent only runs for issues still open.
  const fresh = active.length > 0 ? await freshStates(context, active) : null;
  if (active.length > 0 && !fresh) {
    setRows(db, active, { nextCheckAt: now + CONFIG.triageRecheckSeconds });
    active = [];
  }
  const closedByNr = active.filter((r) => fresh?.get(r.issueId)?.state === "CLOSED");
  setRows(db, closedByNr, { state: "nr_closed", nextCheckAt: null });
  lines.push(...closedByNr.map((r) => actionLine("nr_closed", r.title)));
  const open = active.filter((r) => !closedByNr.includes(r));

  if (open.length > 0) {
    // A fresh session keeps the original analysis intact for repeat detection; rows stay keyed to the original session.
    const recheckId = crypto.randomUUID();
    setRows(db, open, { state: "pending", verdict: null, recheckSessionId: recheckId });
    const started = await startAgentSession(context, {
      sessionId: recheckId,
      kind: SESSION_KIND.MONITOR,
      title: `Re-check: ${monitor.name}`,
      message: recheckMessage(monitor.name, open, now, parseVerdict(readAnalysis(db, sessionId)).summary),
      tools: { report_issue_status: reportIssueStatusTool(db, open.map((r) => r.issueId)) },
      onComplete: () => void applyTriage(context, sessionId, true)
        .then((t) => postUpdate(context, monitor.name, t))
        .catch((err) => console.error("[triage] re-check failed:", errorText(err))),
    });
    if ("error" in started) {
      console.warn(`[triage] "${monitor.name}" re-check not started:`, started.error);
      db.delete(chatSessions).where(eq(chatSessions.id, recheckId)).run();
      sessionChanged(recheckId);
      setRows(db, open, { state: "watching", nextCheckAt: now + BUSY_RETRY_SECONDS, recheckSessionId: null });
    }
  }
  await postUpdate(context, monitor.name, lines.length > 0 ? { action: lines.join("; "), ping } : null);
}

/** Runs each scheduler tick: re-checks due watched issues and sweeps stale pending ones. */
export async function checkWatches(context: Context): Promise<void> {
  const { db } = context;
  const now = unixNow();
  db.delete(alertIssues).where(and(inArray(alertIssues.state, TERMINAL_STATES), lt(alertIssues.updatedAt, now - CONFIG.triageRetentionSeconds))).run();
  const stale = db.select().from(alertIssues)
    .where(and(eq(alertIssues.state, "pending"), lt(alertIssues.updatedAt, now - PENDING_STALE_SECONDS))).all();
  for (const sessionId of new Set(stale.map((r) => r.sessionId))) {
    const running = [sessionId, ...stale.filter((r) => r.sessionId === sessionId).map((r) => r.recheckSessionId)];
    if (running.some((id) => id && context.activeStreams.has(id))) continue;
    try {
      // The agent died or the server restarted mid-run: the report is treated as unknown.
      db.update(alertIssues).set({ verdict: null }).where(and(eq(alertIssues.sessionId, sessionId), eq(alertIssues.state, "pending"))).run();
      const name = db.select({ name: monitors.name }).from(monitors).where(eq(monitors.id, stale.find((r) => r.sessionId === sessionId)!.monitorId)).get()?.name ?? "monitor";
      await postUpdate(context, name, await applyTriage(context, sessionId, true));
    } catch (err) {
      console.error("[triage] stale sweep failed:", errorText(err));
    }
  }

  const due = db.select().from(alertIssues)
    .where(and(eq(alertIssues.state, "watching"), lte(alertIssues.nextCheckAt, now))).all();
  for (const sessionId of new Set(due.map((r) => r.sessionId))) {
    const rows = due.filter((r) => r.sessionId === sessionId);
    try {
      await recheckSession(context, sessionId, rows, now);
    } catch (err) {
      console.error("[triage] re-check failed:", errorText(err));
    }
  }
}

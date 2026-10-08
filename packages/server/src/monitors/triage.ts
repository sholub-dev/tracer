import { and, countDistinct, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { z } from "zod";
import { tool, type Tool, type UIMessage } from "ai";
import { substituteWindow, unixNow } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import type { Db } from "../db/driver.js";
import { alertIssues, monitors, monitorTriggers, sessionTimers } from "../db/schema.js";
import { CONFIG, SETTINGS_KEYS } from "../config.js";
import { localDeviceId, readAppSetting } from "../db/config-reader.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import type { AiIssue } from "../providers/newrelic/nerdgraph.client.js";
import { buildIssueActionTool } from "../providers/newrelic/tools.js";
import { clip, postSlack, readSlackConfig, triageUpdate } from "../integrations/slack.js";
import { hasPendingTimer } from "../tools/timer-tool.js";
import { MONITOR_ROLE, reportAlertSummaryTool, SEVERITIES, SLACK_RULE, summaryInstruction } from "./alert-summary.js";
import { ensureFollowUp, postExpiry, postRecheck } from "./follow-up.js";
import { outcomeSummary, readOutcome, saveOutcome } from "./repeats.js";
import { withTimeout } from "./validate.js";

const ISSUE_STATUSES = ["stopped", "ongoing", "recurring", "unknown"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

type Monitor = typeof monitors.$inferSelect;
type IssueRow = typeof alertIssues.$inferSelect;
export type Triage = { action: string; ping: boolean };
export type FoundIssues = { open: AiIssue[]; closed: AiIssue[]; tracked: number } | { error: string };

// Issues can open hours before the incident event that fired the monitor.
const ISSUE_LOOKBACK_SECONDS = 6 * 3600;
const PENDING_STALE_SECONDS = 3600;
const TITLE_MAX_CHARS = 150;
const REASON_MAX_CHARS = 200;
const TERMINAL_STATES = ["closed", "nr_closed", "left_open"];

/** Settings switch, off by default: when off, monitors only post their analysis. */
export async function triageEnabled(db: Db): Promise<boolean> {
  return await readAppSetting<boolean>(db, SETTINGS_KEYS.alertTriage) === true;
}

export const ingestLagSeconds = (query: string) =>
  incidentQuery(query) ? CONFIG.monitorIncidentLagSeconds : CONFIG.monitorIngestLagSeconds;

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
export const conditionOf = (i: AiIssue) => i.conditionName?.[0] ?? "";

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
    const handled = matched.size === 0 ? [] : await context.db.select({ id: alertIssues.issueId }).from(alertIssues)
      .where(inArray(alertIssues.issueId, [...matched.keys()])).all();
    for (const { id } of handled) matched.delete(id);
    // An ack in New Relic means another Tracer app or a person already took the issue.
    const acked = [...matched.values()].filter((i) => i.acknowledgedAt && i.state !== "CLOSED");
    for (const i of acked) matched.delete(i.issueId);
    const fresh = [...matched.values()];
    return { open: fresh.filter((i) => i.state !== "CLOSED"), closed: fresh.filter((i) => i.state === "CLOSED"), tracked: handled.length + acked.length };
  } catch (err) {
    return { error: errorText(err) };
  }
}

/** Records the firing's issues; returns the ids that belong to this session. A concurrent firing may have recorded the same issue first. */
export async function recordIssues(db: Db, ids: { monitorId: string; triggerId: string; sessionId: string }, found: { open: AiIssue[]; closed: AiIssue[] }): Promise<Set<string>> {
  const now = unixNow();
  const rows = [...found.open.map((i) => [i, "pending"] as const), ...found.closed.map((i) => [i, "nr_closed"] as const)]
    .map(([i, state]) => ({
      ...ids, issueId: i.issueId, conditionName: conditionOf(i), title: titleOf(i), state, createdAt: now, updatedAt: now,
    }));
  if (rows.length === 0) return new Set();
  await db.insert(alertIssues).values(rows).onConflictDoNothing().run();
  const mine = await db.select({ id: alertIssues.issueId }).from(alertIssues)
    .where(and(eq(alertIssues.sessionId, ids.sessionId), inArray(alertIssues.issueId, rows.map((r) => r.issueId)))).all();
  return new Set(mine.map((r) => r.id));
}

type ListedIssue = { issueId: string; conditionName: string; title: string };

const issueList = (issues: ListedIssue[], closes: Map<string, number> = new Map()) =>
  issues.map((i) => {
    const n = closes.get(i.issueId) ?? 0;
    const note = n > 0 ? ` | Tracer closed this condition ${n} time${n === 1 ? "" : "s"} on earlier firings in the last ${Math.round(CONFIG.triageLoopWindowSeconds / 3600)}h` : "";
    return `- ${i.issueId}: ${i.conditionName || "unknown condition"} | ${i.title}${note}`;
  });

// In the tool result too, so later chat turns can explain what the report did in New Relic.
export const TRIAGE_EFFECT = "Alert triage is on: you act on these issues yourself. close_nr_issue acks and closes a stopped issue in New Relic, which closes its JSM alert. Tracer records what happened and reports it after the run. Ongoing or recurring: leave the issue open and follow up with a timer. Unknown: leave it open; people are pinged.";
const REPORT_INSTRUCTION = "for each issue id above that a query result up to now shows stopped (no error since a time you name in reason), call close_nr_issue alone in its own step: it acks first, then closes. Then call report_issue_status once with the severity and, for each issue id above, its status: stopped, ongoing, recurring or unknown. Without that result, use unknown and close nothing. An issue that keeps coming back after closes is usually recurring: decide from the data whether closing it again helps, and say why in the reason.";

export function issuesPrompt(open: AiIssue[], closes: Map<string, number>): string[] {
  if (open.length === 0) return [];
  return [
    "",
    "New Relic issues of this firing that are still open:",
    ...issueList(open.map((i) => ({ issueId: i.issueId, conditionName: conditionOf(i), title: titleOf(i) })), closes),
    `After report_finding, ${REPORT_INSTRUCTION} Base it on the data up to now. Make the calls in this order: report_finding, then the close calls, then report_issue_status alone in its own step, then report_alert_summary alone in its own step, all before any visual.`,
  ];
}

/**
 * For an NrAiIncident monitor with no issue known to be open: the agent first checks that the alert is still open.
 * Another device or a person can resolve it before this one checks the window.
 */
export function closedCheckPrompt(found: FoundIssues | null, slack: boolean): string[] {
  const known = found && !("error" in found) && found.closed.length + found.tracked > 0
    ? [`Tracer found no open New Relic issue for this firing: ${found.closed.length} already closed, ${found.tracked} handled by an earlier alert.`]
    : [];
  return [
    "",
    "First check that this alert is still open. Query NrAiIncident for this firing's incidents up to now, with latest(event) FACET incidentId and the monitor query's filters. An incident whose latest event is 'close' is closed: a person resolved it, or another Tracer device handled it.",
    ...known,
    `If every incident of this firing is closed, call dismiss_alert alone with the result that shows it, then report_finding with that result, then stop: no investigation, no report_alert_summary${slack ? ", nothing goes to Slack" : ""}. If any incident is still open, or the data does not show its state, investigate.`,
  ];
}

type IssueReport = { severity: (typeof SEVERITIES)[number]; issues: { issueId: string; status: IssueStatus; reason: string }[] };

export function reportIssueStatusTool(db: Db, allowedIds: string[], sessionId: string): Tool<IssueReport, { error: string } | { recorded: number; next: string }> {
  return tool({
    description: `Report the severity and the status of each New Relic issue listed in the prompt. ${TRIAGE_EFFECT} Call it once, alone in its step, right after report_finding and your close calls. It only records the report.`,
    inputSchema: z.object({
      severity: z.enum(SEVERITIES),
      issues: z.array(z.object({
        issueId: z.string(),
        status: z.enum(ISSUE_STATUSES),
        reason: z.string().describe("Why this status, in a few words with the key number, e.g. \"Apdex back to 0.97 since 13:58\". For stopped, name the result and the time of the last error. No customer data. " + SLACK_RULE),
      })),
    }),
    execute: async ({ severity, issues }) => {
      const allowed = new Set(allowedIds);
      const rejected = issues.filter((i) => !allowed.has(i.issueId)).map((i) => i.issueId);
      if (rejected.length > 0) return { error: `Not issues of this firing: ${rejected.join(", ")}. Use only the listed issue ids.` };
      const now = unixNow();
      for (const i of issues) {
        await db.update(alertIssues).set({ severity, verdict: i.status, reason: clip(i.reason.trim().replace(/[.\s]+$/, ""), REASON_MAX_CHARS), updatedAt: now })
          .where(and(eq(alertIssues.issueId, i.issueId), eq(alertIssues.sessionId, sessionId))).run();
      }
      return { recorded: issues.length, next: "Tracer reports these statuses and your closes after the run." };
    },
  });
}

export interface DecideInput {
  verdict: IssueStatus;
  /** New Relic shows the issue closed although the agent did not close it. */
  nrClosed: boolean;
  watchExpired: boolean;
  hasFollowUp: boolean;
  recheck: boolean;
  /** The error of the agent's last failed close. */
  closeError?: string | null;
}

export type Decision = { outcome: "watching" | "nr_closed" | "left_open"; ping: boolean; reason?: string };

/** What happens to an issue the agent did not close. */
export function decide(i: DecideInput): Decision {
  if (i.nrClosed) return { outcome: "nr_closed", ping: false };
  if (i.verdict === "unknown") return { outcome: "left_open", ping: true, reason: "status unknown" };
  if (i.verdict === "stopped") return { outcome: "left_open", ping: true, reason: i.closeError ? "close failed" : "not closed" };
  if (i.watchExpired) return { outcome: "left_open", ping: true, reason: "still ongoing after 24h" };
  if (!i.hasFollowUp) return { outcome: "left_open", ping: true, reason: "no re-check set" };
  return { outcome: "watching", ping: !i.recheck };
}

// The condition name is short; raw issue titles can be whole error messages.
const nameOf = (r: { conditionName: string | null; title: string | null }) => r.conditionName || r.title || "unknown issue";

function actionLine(state: string, title: string, reason?: string, why?: string | null): string {
  const labels: Record<string, string> = {
    closed: "Acked and closed in New Relic",
    watching: "Still ongoing, left open, re-check set",
    nr_closed: "Already closed in New Relic",
  };
  const label = labels[state] ?? `Left open (${reason ?? "unknown"})`;
  return `${label}: ${clip(title, TITLE_MAX_CHARS)}${why ? `. Why: ${why}` : ""}`;
}

// Counts earlier firings, not sibling issues of this one.
async function recentCloses(db: Db, monitorId: string, conditionName: string, sessionId: string, now: number): Promise<number> {
  return (await db.select({ n: countDistinct(alertIssues.sessionId) }).from(alertIssues).where(and(
    eq(alertIssues.monitorId, monitorId),
    eq(alertIssues.conditionName, conditionName),
    eq(alertIssues.state, "closed"),
    gte(alertIssues.updatedAt, now - CONFIG.triageLoopWindowSeconds),
    ne(alertIssues.sessionId, sessionId),
  )).get())?.n ?? 0;
}

/** Per issue id: how often Tracer closed its condition on earlier firings of the monitor within the loop window. */
export async function closeCounts(db: Db, monitorId: string, sessionId: string, issues: { issueId: string; conditionName: string }[]): Promise<Map<string, number>> {
  const now = unixNow();
  return new Map(await Promise.all(issues.map(async (i) => [i.issueId, await recentCloses(db, monitorId, i.conditionName, sessionId, now)] as const)));
}

async function freshStates(context: Context, rows: IssueRow[]): Promise<Map<string, AiIssue> | null> {
  const nr = newRelic(context);
  if (!nr || rows.length === 0) return null;
  const trigger = await context.db.select({ windowStart: monitorTriggers.windowStart }).from(monitorTriggers)
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

/** ack_nr_issue and close_nr_issue for a monitor run, limited to the issues of this firing; none when New Relic is not connected. */
export function monitorIssueTools(context: Context, issueIds: string[], sessionId: string): Record<string, Tool> {
  const nr = newRelic(context);
  if (!nr || issueIds.length === 0) return {};
  const allowed = new Set(issueIds);
  const guard = async (id: string, run: () => Promise<{ ok: true } | { error: string }>) => {
    if (!allowed.has(id)) return { error: `Not an issue of this firing: ${id}. Allowed issue ids: ${issueIds.join(", ")}.` };
    // The Settings switch can turn off between the firing and a Retry or follow-up.
    if (!await triageEnabled(context.db)) return { error: "Alert triage is turned off in Settings. Leave the issue open." };
    return run();
  };
  return {
    ack_nr_issue: buildIssueActionTool(
      "Acknowledge a New Relic issue of this firing. For a stopped issue use close_nr_issue, which acks too.",
      (id) => guard(id, () => nr.ackIssue(id)),
    ),
    close_nr_issue: buildIssueActionTool(
      "Ack and close a New Relic issue of this firing. Close an issue only when a query result up to now shows it stopped. Never close other issues.",
      (id) => guard(id, async () => {
        const result = await ackThenClose(nr, id);
        const fields = "error" in result ? { lastError: result.error } : { state: "closed", lastError: null };
        await context.db.update(alertIssues).set({ ...fields, updatedAt: unixNow() }).where(and(eq(alertIssues.issueId, id), eq(alertIssues.sessionId, sessionId))).run();
        return result;
      }),
    ),
  };
}

/** Records what happened to the session's issues (the agent acts itself); returns the Slack action and whether to ping. `ids` limits a re-check to the issues it covered. */
export async function applyTriage(context: Context, sessionId: string, recheck: boolean, ids?: string[]): Promise<Triage | null> {
  const { db } = context;
  const states = recheck ? ["pending"] : ["pending", "nr_closed", "closed"];
  const rows = await db.select().from(alertIssues)
    .where(and(eq(alertIssues.sessionId, sessionId), ids ? inArray(alertIssues.issueId, ids) : inArray(alertIssues.state, states))).all();
  if (rows.length === 0) return null;
  const enabled = await triageEnabled(db);
  const pending = rows.filter((r) => r.state === "pending");
  const fresh = await freshStates(context, pending);
  // Both 24h limits count from the firing, so the issue and the follow-up expire together.
  const fired = await db.select({ triggeredAt: monitorTriggers.triggeredAt }).from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
  const followUp = await hasPendingTimer(db, sessionId);
  const lines: string[] = [];
  let ping = false;
  for (const row of rows) {
    if (row.state === "nr_closed" || row.state === "closed") {
      const agent = row.state === "closed";
      lines.push(actionLine(row.state, nameOf(row), undefined, agent ? row.reason : null));
      ping ||= agent && !recheck && row.severity === "high";
      continue;
    }
    if (row.state !== "pending") continue;
    const now = unixNow();
    const d: Decision = !enabled
      ? { outcome: "left_open", ping: true, reason: "triage turned off" }
      : decide({
        verdict: (row.verdict ?? "unknown") as IssueStatus,
        nrClosed: fresh?.get(row.issueId)?.state === "CLOSED",
        watchExpired: row.watchUntil !== null && now >= row.watchUntil,
        hasFollowUp: followUp,
        recheck,
        closeError: row.lastError,
      });
    const watching = d.outcome === "watching";
    await db.update(alertIssues).set({
      state: d.outcome,
      watchUntil: watching ? (row.watchUntil ?? (fired?.triggeredAt ?? now) + CONFIG.triageWatchMaxSeconds) : row.watchUntil,
      updatedAt: now,
    }).where(eq(alertIssues.issueId, row.issueId)).run();
    ping ||= d.ping;
    if (!(recheck && watching)) lines.push(actionLine(d.outcome, nameOf(row), d.reason, row.reason));
  }
  return { action: lines.join("; "), ping };
}

/** Pending issues of a session, for a re-run of its firing. */
export async function pendingIssueIds(db: Db, sessionId: string): Promise<string[]> {
  return (await db.select({ id: alertIssues.issueId }).from(alertIssues)
    .where(and(eq(alertIssues.sessionId, sessionId), eq(alertIssues.state, "pending"))).all()).map((r) => r.id);
}

/** Drops the status reports of a run that did not finish, so its issues are left open. */
export async function forgetReports(db: Db, sessionId: string): Promise<void> {
  await db.update(alertIssues).set({ verdict: null, reason: null }).where(and(eq(alertIssues.sessionId, sessionId), eq(alertIssues.state, "pending"))).run();
}

/** The Slack action for a finished firing investigation; never throws. Without `found` (a re-run) it acts on the recorded issues only. */
export async function triageAfterRun(context: Context, sessionId: string, found?: FoundIssues | null): Promise<Triage | undefined> {
  if (found && "error" in found) {
    console.warn("[triage] could not read the New Relic issues:", found.error);
    return { action: "Triage skipped: could not read the New Relic issues", ping: true };
  }
  try {
    const triage = await applyTriage(context, sessionId, false);
    if (triage || !found) return triage ?? undefined;
    // Found issues with no rows here were recorded first by a concurrent firing.
    return found.tracked + found.open.length + found.closed.length > 0
      ? { action: "No new New Relic issue for this firing", ping: false }
      : { action: "Triage skipped: no New Relic issue matched this firing", ping: true };
  } catch (err) {
    console.error("[triage] failed:", errorText(err));
    return { action: "Triage failed", ping: true };
  }
}

/** Acks the session's issues still open and unacked in New Relic, so another Tracer app skips them. Never throws. */
export async function ackRemaining(context: Context, sessionId: string): Promise<void> {
  try {
    const nr = newRelic(context);
    if (!nr || !await triageEnabled(context.db)) return;
    const rows = await context.db.select().from(alertIssues).where(eq(alertIssues.sessionId, sessionId)).all();
    const fresh = await freshStates(context, rows);
    for (const issue of fresh?.values() ?? []) {
      if (issue.state === "CLOSED" || issue.acknowledgedAt) continue;
      const ack = await nr.ackIssue(issue.issueId);
      if ("error" in ack) console.warn(`[triage] ack of ${issue.issueId} failed:`, ack.error);
    }
  } catch (err) {
    console.warn("[triage] ack failed:", errorText(err));
  }
}

type AlertRef = Pick<IssueRow, "monitorId" | "sessionId">;

async function postUpdate(context: Context, ref: AlertRef, triage: Triage | null): Promise<void> {
  if (!triage?.action) return;
  const { db } = context;
  const name = await monitorName(db, ref.monitorId);
  try {
    const slack = await readSlackConfig(db);
    if (!slack) return;
    const result = await postSlack(slack.webhookUrl, triageUpdate({
      name, ...triage, mentions: slack.mentions,
      alert: outcomeSummary(await readOutcome(db, ref.sessionId)),
    }));
    if ("error" in result) console.warn(`[triage] "${name}" Slack post failed:`, result.error);
  } catch (err) {
    console.warn(`[triage] "${name}" Slack post failed:`, errorText(err));
  }
}

async function setRows(db: Db, rows: IssueRow[], fields: Partial<IssueRow>): Promise<void> {
  if (rows.length === 0) return;
  await db.update(alertIssues).set({ ...fields, updatedAt: unixNow() }).where(inArray(alertIssues.issueId, rows.map((r) => r.issueId))).run();
}

async function leaveOpen(context: Context, rows: IssueRow[], reason: string): Promise<void> {
  if (rows.length === 0) return;
  await setRows(context.db, rows, { state: "left_open" });
  await postUpdate(context, rows[0], {
    action: rows.map((r) => actionLine("left_open", nameOf(r), reason)).join("; "), ping: true,
  });
}

const monitorName = async (db: Db, monitorId: string) =>
  (await db.select({ name: monitors.name }).from(monitors).where(eq(monitors.id, monitorId)).get())?.name ?? "monitor";

/** Starts the message of a follow-up timer wake-up; a resumed run uses it to tell a wake-up from a chat turn. */
export const WAKEUP_MARK = "Follow-up timer (";

export function isWakeupTurn(messages: UIMessage[]): boolean {
  const last = messages[messages.map((m) => m.role).lastIndexOf("user")];
  return !!last?.parts.some((p) => p.type === "text" && p.text.startsWith(WAKEUP_MARK));
}

export type Wakeup = { lines: string[]; tools?: Record<string, unknown>; onComplete?: (outcome: { error?: string }) => void; revert?: () => Promise<void> };
type Watched = { lines: string[]; tools?: Record<string, unknown>; triage?: () => Promise<Triage | null>; revert?: () => Promise<void> };

/** The triage re-check of a session's watched issues; nothing when it has none. */
async function watchedIssues(context: Context, sessionId: string): Promise<Watched> {
  const { db } = context;
  // Pending rows with a watch limit belong to a wake-up that a restart interrupted.
  const rows = await db.select().from(alertIssues).where(and(
    eq(alertIssues.sessionId, sessionId),
    or(eq(alertIssues.state, "watching"), and(eq(alertIssues.state, "pending"), isNotNull(alertIssues.watchUntil))),
  )).all();
  if (rows.length === 0) return { lines: [] };
  const monitor = await db.select().from(monitors).where(eq(monitors.id, rows[0].monitorId)).get();
  const stopReason = !await triageEnabled(db) ? "triage turned off"
    : !monitor?.enabled || monitor.alertEnabled === 0 ? "monitor or its alerts turned off"
    : null;
  if (stopReason) {
    await leaveOpen(context, rows, `stopped watching, ${stopReason}`);
    return { lines: [] };
  }
  const now = unixNow();
  // The final 24h line comes from the follow-up duty, so these are closed without a post.
  await setRows(db, rows.filter((r) => r.watchUntil !== null && now >= r.watchUntil), { state: "left_open" });
  const active = rows.filter((r) => r.watchUntil === null || now < r.watchUntil);
  if (active.length === 0) return { lines: [] };

  const activeIds = active.map((r) => r.issueId);
  await setRows(db, active, { state: "pending", verdict: null, reason: null });
  return {
    lines: [
      "",
      "New Relic issues still being followed up:",
      ...issueList(active, await closeCounts(db, rows[0].monitorId, sessionId, active)),
      `Look at the data since the last check only, with the fewest queries possible. Then ${REPORT_INSTRUCTION}`,
    ],
    tools: { report_issue_status: reportIssueStatusTool(db, activeIds, sessionId), ...monitorIssueTools(context, activeIds, sessionId) },
    triage: () => applyTriage(context, sessionId, true, activeIds),
    revert: () => setRows(db, active, { state: "watching" }),
  };
}

/**
 * A wake-up that failed or was interrupted must not end the chain: its issues go back to watching, and an alert
 * that was ongoing at its last report gets another check. Posts nothing, except the final line when the 24h ended.
 */
export async function wakeupFailed(context: Context, sessionId: string): Promise<void> {
  const { db } = context;
  await db.update(alertIssues).set({ state: "watching", verdict: null, reason: null })
    .where(and(eq(alertIssues.sessionId, sessionId), eq(alertIssues.state, "pending"), isNotNull(alertIssues.watchUntil))).run();
  if (await ensureFollowUp(context, sessionId, (await readOutcome(db, sessionId)).report)) await postExpiry(context, sessionId);
}

/** Turns a follow-up timer wake-up of a monitor session into a re-check: role lines, alert report, and the triage re-check of watched issues. */
export async function wakeupExtras(context: Context, sessionId: string): Promise<Wakeup> {
  const { db } = context;
  const trigger = await db.select({ monitorId: monitorTriggers.monitorId }).from(monitorTriggers).where(eq(monitorTriggers.sessionId, sessionId)).get();
  if (!trigger) return { lines: [] };
  const watched = await watchedIssues(context, sessionId);
  const slack = await readSlackConfig(db) !== null;
  return {
    lines: ["", MONITOR_ROLE, ...watched.lines, `Answer with report_finding.${summaryInstruction(slack)}`],
    tools: { report_alert_summary: reportAlertSummaryTool({ slack }), ...watched.tools },
    onComplete: ({ error }) => {
      void (async () => {
        if (error) return wakeupFailed(context, sessionId);
        const outcome = await readOutcome(db, sessionId);
        // Later firings read the stored outcome, so it follows each re-check.
        await saveOutcome(db, sessionId, outcome);
        const expired = await ensureFollowUp(context, sessionId, outcome.latestReport);
        await postRecheck(context, sessionId, await watched.triage?.() ?? null, expired);
      })().catch((err) => console.error("[triage] follow-up failed:", errorText(err)));
    },
    revert: watched.revert,
  };
}

/** Runs each scheduler tick: sweeps stale pending issues, watched issues left without a follow-up, and old rows. */
export async function checkWatches(context: Context): Promise<void> {
  const { db } = context;
  const now = unixNow();
  await db.delete(alertIssues).where(and(inArray(alertIssues.state, TERMINAL_STATES), lt(alertIssues.updatedAt, now - CONFIG.triageRetentionSeconds))).run();
  const stale = await db.select().from(alertIssues)
    .where(and(eq(alertIssues.state, "pending"), lt(alertIssues.updatedAt, now - PENDING_STALE_SECONDS))).all();
  for (const sessionId of new Set(stale.map((r) => r.sessionId))) {
    if (context.activeStreams.has(sessionId)) continue;
    try {
      // The agent died or the server restarted mid-run: the report is treated as unknown.
      await forgetReports(db, sessionId);
      const first = stale.find((r) => r.sessionId === sessionId)!;
      const followUp = first.watchUntil !== null;
      // A first run that died reports its closes too, as a finished run does.
      const triage = await applyTriage(context, sessionId, followUp);
      const run = followUp ? "Re-check" : "Investigation";
      await postUpdate(context, first, triage && { ...triage, action: `${run} never finished. ${triage.action}` });
    } catch (err) {
      console.error("[triage] stale sweep failed:", errorText(err));
    }
  }

  // The timer was cancelled or its session deleted.
  // Synced rows of another device are not ours: that device owns their timers.
  const orphaned = (await db.select({ row: alertIssues }).from(alertIssues)
    .innerJoin(monitorTriggers, eq(monitorTriggers.id, alertIssues.triggerId))
    .leftJoin(sessionTimers, and(eq(sessionTimers.sessionId, alertIssues.sessionId), isNotNull(sessionTimers.fireAt)))
    .where(and(eq(alertIssues.state, "watching"), eq(monitorTriggers.deviceId, await localDeviceId(db)), isNull(sessionTimers.sessionId))).all()).map((r) => r.row);
  for (const sessionId of new Set(orphaned.map((r) => r.sessionId))) {
    try {
      await leaveOpen(context, orphaned.filter((r) => r.sessionId === sessionId), "no re-check set");
    } catch (err) {
      console.error("[triage] watch sweep failed:", errorText(err));
    }
  }
}

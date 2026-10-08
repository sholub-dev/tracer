import { and, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { tool, type Tool, type UIMessage } from "ai";
import { SESSION_KIND, type Finding } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { chatSessions, monitorTriggers } from "../db/schema.js";
import { extractAnalysis } from "../agents/analysis.js";
import { CONFIG } from "../config.js";
import { decodeMessages } from "../lib/messages-codec.js";
import { redact } from "../integrations/slack.js";
import { alertFindingFromMessages, dismissalFromMessages, firstSentence, latestRunSummary, summaryFromMessages, type AlertSummary } from "./alert-summary.js";
import type { Group } from "./condition.js";

export interface TriggerGroup extends Group {
  sessionId: string | null;
  repeat: boolean;
}

export interface PastSession {
  sessionId: string;
  triggeredAt: number;
  keys: string[];
  analysis: string;
  report: AlertSummary | null;
  finding: Finding | null;
}

const PAST_SESSIONS_LIMIT = 5;
const PAST_SESSIONS_SCAN = 30;
const ANALYSIS_MAX_CHARS = 6000;

export function parseTriggerGroups(json: string): TriggerGroup[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A group repeats when an investigated trigger inside the repeat window covered the same key. */
export async function classifyGroups(db: Db, monitorId: string, groups: Group[], now: number): Promise<TriggerGroup[]> {
  const recent = (await db
    .select({ groups: monitorTriggers.groups })
    .from(monitorTriggers)
    .where(and(
      eq(monitorTriggers.monitorId, monitorId),
      eq(monitorTriggers.status, "investigating"),
      gte(monitorTriggers.triggeredAt, now - CONFIG.monitorRepeatWindowSeconds),
    ))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .all())
    .map((r) => parseTriggerGroups(r.groups));
  return groups.map((g) => {
    // An unfaceted group has no identity, so each trigger gets investigated.
    if (g.key === "") return { ...g, sessionId: null, repeat: false };
    for (const past of recent) {
      const hit = past.find((pg) => pg.key === g.key && !pg.repeat && pg.sessionId);
      if (hit) return { ...g, sessionId: hit.sessionId, repeat: true };
    }
    return { ...g, sessionId: null, repeat: false };
  });
}

export function byRelevance<T extends { keys: string[] }>(newestFirst: T[], currentKeys: string[]): T[] {
  const current = new Set(currentKeys.filter(Boolean));
  const shares = (p: T) => p.keys.some((k) => current.has(k));
  return [...newestFirst.filter(shares), ...newestFirst.filter((p) => !shares(p))];
}

export interface Outcome {
  analysis: string;
  /** The last report of any run of the session. */
  report: AlertSummary | null;
  /** The report of the latest run only; null when that run reported none. */
  latestReport: AlertSummary | null;
  finding: Finding | null;
  dismissed: string | null;
}

/** A session's analysis, the answer card and the alert details it reported. */
export async function readOutcome(db: Db, sessionId: string): Promise<Outcome> {
  const row = await db.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  try {
    const messages = row ? decodeMessages(row.messages) : [];
    return { analysis: extractAnalysis(messages).analysis, report: summaryFromMessages(messages), latestReport: latestRunSummary(messages), finding: alertFindingFromMessages(messages), dismissed: dismissalFromMessages(messages) };
  } catch {
    return { analysis: "", report: null, latestReport: null, finding: null, dismissed: null };
  }
}

export const outcomeSummary = (o: { analysis: string; finding: Finding | null }) => o.finding?.headline ?? firstSentence(o.analysis);
/** The one-line summary of a past run, for the prompt. */
export const pastSummary = (p: PastSession) => redact(outcomeSummary(p));

type StoredOutcome = Pick<Outcome, "analysis" | "report" | "finding" | "dismissed">;

const truncated = (analysis: string) => analysis.length > ANALYSIS_MAX_CHARS ? `${analysis.slice(0, ANALYSIS_MAX_CHARS)} …[truncated]` : analysis;

/** Keeps the result of a finished run on its firing, so later firings read it without decoding the session. */
export async function saveOutcome(db: Db, sessionId: string, { analysis, report, finding, dismissed }: Outcome): Promise<void> {
  const stored: StoredOutcome = { analysis: truncated(analysis), report, finding, dismissed };
  await db.update(monitorTriggers).set({ outcome: JSON.stringify(stored) }).where(eq(monitorTriggers.sessionId, sessionId)).run();
}

function parseStoredOutcome(json: string | null): StoredOutcome | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return typeof parsed?.analysis === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function pastSessions(db: Db, monitorId: string, currentKeys: string[], before = Number.MAX_SAFE_INTEGER): Promise<PastSession[]> {
  const triggers = (await db
    .select({ sessionId: monitorTriggers.sessionId, triggeredAt: monitorTriggers.triggeredAt, groups: monitorTriggers.groups, outcome: monitorTriggers.outcome })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(monitorTriggers.sessionId), lt(monitorTriggers.triggeredAt, before)))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .limit(PAST_SESSIONS_SCAN)
    .all())
    .map((t) => ({ sessionId: t.sessionId!, triggeredAt: t.triggeredAt, keys: parseTriggerGroups(t.groups).map((g) => g.key).filter(Boolean), stored: parseStoredOutcome(t.outcome) }));

  // Parse session messages lazily: they can be large and only a few are kept.
  const picked: PastSession[] = [];
  for (const t of byRelevance(triggers, currentKeys)) {
    if (picked.length === PAST_SESSIONS_LIMIT) break;
    const { stored, ...past } = t;
    const { analysis, report, finding, dismissed } = stored ?? await readOutcome(db, t.sessionId);
    if (dismissed === null && (analysis || report || finding)) picked.push({ ...past, report, finding, analysis: truncated(analysis) });
  }
  return picked.sort((a, b) => b.triggeredAt - a.triggeredAt);
}

type PastSessionResult = { error: string } | { sessionId: string; triggeredAt: string; groups: string[]; summary: AlertSummary | null; finding: Finding | null; analysis: string; note: string };

export function readPastSessionTool(load: () => PastSession[] | Promise<PastSession[]>): Tool<{ sessionId: string }, PastSessionResult> {
  let sessions: PastSession[] | undefined;
  return tool({
    description: "Read the full analysis of a past debug session of this monitor. Its conclusions are hypotheses to test, not evidence. Only the session ids listed in the prompt are allowed.",
    inputSchema: z.object({ sessionId: z.string().describe("Session id from the recent past sessions list") }),
    execute: async ({ sessionId }) => {
      sessions ??= await load();
      const s = sessions.find((p) => p.sessionId === sessionId);
      if (!s) return { error: `Session ${sessionId} is not one of the listed past sessions` };
      return { sessionId, triggeredAt: new Date(s.triggeredAt * 1000).toISOString(), groups: s.keys, summary: s.report, finding: s.finding, analysis: s.analysis, note: "Earlier model-written analysis. Not re-checked. Re-query before quoting its numbers." };
    },
  });
}

/** For follow-up chats in a monitor session: the past sessions as of its firing. */
export async function pastSessionToolFor(db: Db, sessionId: string): Promise<ReturnType<typeof readPastSessionTool> | null> {
  const session = await db.select({ kind: chatSessions.kind }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (session?.kind !== SESSION_KIND.MONITOR) return null;
  const trigger = await db
    .select({ monitorId: monitorTriggers.monitorId, triggeredAt: monitorTriggers.triggeredAt, groups: monitorTriggers.groups })
    .from(monitorTriggers)
    .where(eq(monitorTriggers.sessionId, sessionId))
    .get();
  if (!trigger) return null;
  const keys = parseTriggerGroups(trigger.groups).map((g) => g.key);
  return readPastSessionTool(() => pastSessions(db, trigger.monitorId, keys, trigger.triggeredAt));
}

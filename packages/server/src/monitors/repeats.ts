import { and, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import { tool, type UIMessage } from "ai";
import type { Db } from "../db/client.js";
import { chatSessions, monitorTriggers } from "../db/schema.js";
import { extractAnalysis } from "../agents/analysis.js";
import { CONFIG } from "../config.js";
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
export function classifyGroups(db: Db, monitorId: string, groups: Group[], now: number): TriggerGroup[] {
  const recent = db
    .select({ groups: monitorTriggers.groups })
    .from(monitorTriggers)
    .where(and(
      eq(monitorTriggers.monitorId, monitorId),
      eq(monitorTriggers.status, "investigating"),
      gte(monitorTriggers.triggeredAt, now - CONFIG.monitorRepeatWindowSeconds),
    ))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .all()
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

export function readAnalysis(db: Db, sessionId: string): string {
  const row = db.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!row) return "";
  try {
    return extractAnalysis(JSON.parse(row.messages) as UIMessage[]).analysis;
  } catch {
    return "";
  }
}

export function pastSessions(db: Db, monitorId: string, currentKeys: string[], before = Number.MAX_SAFE_INTEGER): PastSession[] {
  const triggers = db
    .select({ sessionId: monitorTriggers.sessionId, triggeredAt: monitorTriggers.triggeredAt, groups: monitorTriggers.groups })
    .from(monitorTriggers)
    .where(and(eq(monitorTriggers.monitorId, monitorId), isNotNull(monitorTriggers.sessionId), lt(monitorTriggers.triggeredAt, before)))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .limit(PAST_SESSIONS_SCAN)
    .all()
    .map((t) => ({ sessionId: t.sessionId!, triggeredAt: t.triggeredAt, keys: parseTriggerGroups(t.groups).map((g) => g.key).filter(Boolean) }));

  // Parse session messages lazily: they can be large and only a few are kept.
  const picked: PastSession[] = [];
  for (const t of byRelevance(triggers, currentKeys)) {
    if (picked.length === PAST_SESSIONS_LIMIT) break;
    const analysis = readAnalysis(db, t.sessionId);
    if (analysis) picked.push({ ...t, analysis: analysis.length > ANALYSIS_MAX_CHARS ? `${analysis.slice(0, ANALYSIS_MAX_CHARS)} …[truncated]` : analysis });
  }
  return picked.sort((a, b) => b.triggeredAt - a.triggeredAt);
}

export function readPastSessionTool(sessions: PastSession[]) {
  return tool({
    description: "Read the full analysis of a past debug session of this monitor. Only the session ids listed in the prompt are allowed.",
    inputSchema: z.object({ sessionId: z.string().describe("Session id from the recent past sessions list") }),
    execute: async ({ sessionId }) => {
      const s = sessions.find((p) => p.sessionId === sessionId);
      if (!s) return { error: `Session ${sessionId} is not one of the listed past sessions` };
      return { sessionId, triggeredAt: new Date(s.triggeredAt * 1000).toISOString(), groups: s.keys, analysis: s.analysis };
    },
  });
}

/** For follow-up chats in a monitor session: the past sessions as of its firing. */
export function pastSessionToolFor(db: Db, sessionId: string): ReturnType<typeof readPastSessionTool> | null {
  const trigger = db
    .select({ monitorId: monitorTriggers.monitorId, triggeredAt: monitorTriggers.triggeredAt, groups: monitorTriggers.groups })
    .from(monitorTriggers)
    .where(eq(monitorTriggers.sessionId, sessionId))
    .get();
  if (!trigger) return null;
  const keys = parseTriggerGroups(trigger.groups).map((g) => g.key);
  return readPastSessionTool(pastSessions(db, trigger.monitorId, keys, trigger.triggeredAt));
}

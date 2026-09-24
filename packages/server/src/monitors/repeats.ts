import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { Db } from "../db/client.js";
import { chatSessions, monitorTriggers } from "../db/schema.js";
import { extractAnalysis } from "../agents/analysis.js";
import { CONFIG } from "../config.js";
import type { Group } from "./condition.js";

export interface TriggerGroup extends Group {
  sessionId: string | null;
  repeat: boolean;
}

export interface PastSummary {
  sessionId: string;
  triggeredAt: number;
  keys: string[];
  summary: string;
}

const SUMMARY_MAX_CHARS = 1500;

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

export function pastSummaries(db: Db, monitorId: string, limit = 3): PastSummary[] {
  const triggers = db
    .select()
    .from(monitorTriggers)
    .where(and(
      eq(monitorTriggers.monitorId, monitorId),
      eq(monitorTriggers.status, "investigating"),
      isNotNull(monitorTriggers.sessionId),
    ))
    .orderBy(desc(monitorTriggers.triggeredAt))
    .limit(limit)
    .all();
  if (triggers.length === 0) return [];

  const sessions = db
    .select({ id: chatSessions.id, messages: chatSessions.messages })
    .from(chatSessions)
    .where(inArray(chatSessions.id, triggers.map((t) => t.sessionId!)))
    .all();
  const byId = new Map(sessions.map((s) => [s.id, s.messages]));

  return triggers.flatMap((t) => {
    const raw = byId.get(t.sessionId!);
    if (!raw) return [];
    let messages: UIMessage[] = [];
    try {
      messages = JSON.parse(raw);
    } catch {
      return [];
    }
    const { analysis } = extractAnalysis(messages);
    if (!analysis) return [];
    return [{
      sessionId: t.sessionId!,
      triggeredAt: t.triggeredAt,
      keys: parseTriggerGroups(t.groups).filter((g) => !g.repeat).map((g) => g.key),
      summary: analysis.length > SUMMARY_MAX_CHARS ? `${analysis.slice(0, SUMMARY_MAX_CHARS)} …[truncated]` : analysis,
    }];
  });
}

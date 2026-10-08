import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { tool, type Tool } from "ai";
import { unixNow } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { chatSessions, sessionTimers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { formatLocalTime, getTimezone } from "../lib/current-context.js";
import { sessionChanged } from "../lib/session-events.js";

const NOTE_MAX_CHARS = 300;

type TimerInput = { minutes: number; note: string };
type TimerResult = { error: string } | { cancelled: true } | { dueAt: string };

export async function hasPendingTimer(db: Db, sessionId: string): Promise<boolean> {
  return !!await db.select({ id: sessionTimers.sessionId }).from(sessionTimers)
    .where(and(eq(sessionTimers.sessionId, sessionId), isNotNull(sessionTimers.fireAt))).get();
}

/** Sets the session's one follow-up timer, replacing a pending one. */
export async function putTimer(db: Db, sessionId: string, minutes: number, note: string): Promise<number> {
  const now = unixNow();
  const fireAt = now + Math.round(minutes * 60);
  const row = { fireAt, note: note.trim().slice(0, NOTE_MAX_CHARS), setAt: now };
  await db.insert(sessionTimers).values({ sessionId, ...row })
    .onConflictDoUpdate({ target: sessionTimers.sessionId, set: row }).run();
  sessionChanged(sessionId);
  return fireAt;
}

export function setTimerTool(db: Db, sessionId: string): Tool<TimerInput, TimerResult> {
  return tool({
    description: `Wake this chat later to follow up. Use it only when a follow-up is truly needed (e.g. an issue may recover, a deploy is rolling out). For a live incident wait ${CONFIG.timerFollowUpMinutes} minutes; checking too often beats waiting too long.`,
    inputSchema: z.object({
      minutes: z.number().describe(`Minutes from now, ${CONFIG.timerMinMinutes} to ${CONFIG.timerMaxMinutes}; 0 cancels the pending timer`),
      note: z.string().describe("What to check when it fires; no customer data"),
    }),
    execute: async ({ minutes, note }) => {
      if (minutes === 0) {
        await db.delete(sessionTimers).where(eq(sessionTimers.sessionId, sessionId)).run();
        sessionChanged(sessionId);
        return { cancelled: true };
      }
      if (minutes < CONFIG.timerMinMinutes || minutes > CONFIG.timerMaxMinutes) {
        return { error: `minutes must be 0 or ${CONFIG.timerMinMinutes} to ${CONFIG.timerMaxMinutes}` };
      }
      const session = await db.select({ createdAt: chatSessions.createdAt }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
      if (!session) return { error: "This session no longer exists" };
      const limit = session.createdAt + CONFIG.timerMaxAfterSessionSeconds;
      if (unixNow() + Math.round(minutes * 60) > limit) {
        return { error: `Too late: follow-ups must fire within ${CONFIG.timerMaxAfterSessionSeconds / 3600}h of the session start (by ${formatLocalTime(limit, await getTimezone(db))})` };
      }
      const fireAt = await putTimer(db, sessionId, minutes, note);
      return { dueAt: formatLocalTime(fireAt, await getTimezone(db)) };
    },
  });
}

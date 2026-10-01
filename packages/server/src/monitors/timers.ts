import { and, eq, isNull, lte } from "drizzle-orm";
import { SESSION_KIND, unixNow, type SessionKind } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { chatSessions, sessionTimers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { startAgentSession } from "../agents/start-session.js";
import { formatLocalTime, getTimezone } from "../lib/current-context.js";
import { wakeupExtras, type Wakeup } from "./triage.js";

/** Runs each scheduler tick: wakes the sessions whose follow-up timer is due. */
export async function fireDueTimers(context: Context, start = startAgentSession): Promise<void> {
  const { db } = context;
  const now = unixNow();
  const due = db.select({ timer: sessionTimers, kind: chatSessions.kind }).from(sessionTimers)
    .innerJoin(chatSessions, eq(chatSessions.id, sessionTimers.sessionId))
    .where(lte(sessionTimers.fireAt, now)).orderBy(sessionTimers.fireAt).all();
  const tz = getTimezone(db);
  let started = 0;
  for (const { timer, kind } of due) {
    if (started >= CONFIG.timerMaxWakeupsPerTick) break;
    const { sessionId } = timer;
    const retryLater = () => db.update(sessionTimers).set({ fireAt: unixNow() + CONFIG.timerBusyRetrySeconds })
      .where(eq(sessionTimers.sessionId, sessionId)).run();
    if (context.activeStreams.has(sessionId)) {
      retryLater();
      continue;
    }
    db.update(sessionTimers).set({ fireAt: null }).where(eq(sessionTimers.sessionId, sessionId)).run();
    started++;
    let extras: Wakeup | undefined;
    try {
      extras = await wakeupExtras(context, sessionId);
      const at = (t: number) => formatLocalTime(t, tz);
      const result = await start(context, {
        sessionId,
        kind: (kind ?? SESSION_KIND.API) as SessionKind,
        message: [
          `Follow-up timer (set ${at(timer.setAt)}, due ${at(timer.fireAt!)}, now ${at(now)}): ${timer.note.replace(/[.\s]+$/, "")}. Check it now.`,
          ...extras.lines,
        ].join("\n"),
        tools: extras.tools,
        onComplete: extras.onComplete,
      });
      if ("error" in result) {
        extras.revert?.();
        retryLater();
        console.warn(`[timer] follow-up for session ${sessionId} not started:`, result.error);
      } else {
        // Keep a timer the woken run already set again.
        db.delete(sessionTimers).where(and(eq(sessionTimers.sessionId, sessionId), isNull(sessionTimers.fireAt))).run();
      }
    } catch (err) {
      extras?.revert?.();
      retryLater();
      console.error(`[timer] follow-up for session ${sessionId} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}

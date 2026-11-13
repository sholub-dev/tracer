import { and, eq, isNull, lte } from "drizzle-orm";
import { SESSION_KIND, unixNow, type SessionKind } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { chatSessions, sessionTimers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { startAgentSession } from "../agents/start-session.js";
import { formatLocalTime, getTimezone } from "../lib/current-context.js";
import { WAKEUP_MARK, wakeupExtras, type Wakeup } from "./triage.js";
import { dropTimer, issuesEnded, monitorStopped } from "./follow-up.js";
import { sessionChanged } from "../lib/session-events.js";

const REARM_DELAY_SECONDS = 120;
/** Timers (session and set time) re-armed once since their last successful wake-up; an app restart clears it. */
const retried = new Set<string>();

/** Runs each scheduler tick: wakes the sessions whose follow-up timer is due. */
export async function fireDueTimers(context: Context, start = startAgentSession): Promise<void> {
  const { db } = context;
  const now = unixNow();
  const due = await db.select({ timer: sessionTimers, kind: chatSessions.kind, scope: chatSessions.runScope }).from(sessionTimers)
    .innerJoin(chatSessions, eq(chatSessions.id, sessionTimers.sessionId))
    .where(lte(sessionTimers.fireAt, now)).orderBy(sessionTimers.fireAt).all();
  if (due.length === 0) return;
  const tz = await getTimezone(db);
  let started = 0;
  for (const { timer, kind, scope } of due) {
    if (started >= CONFIG.timerMaxWakeupsPerTick) break;
    const { sessionId } = timer;
    const retryLater = async () => {
      // A wake-up that cannot start for a day is dropped, like any follow-up past its limit.
      if (unixNow() >= timer.setAt + CONFIG.timerMaxAfterSessionSeconds) return dropTimer(db, sessionId);
      await db.update(sessionTimers).set({ fireAt: unixNow() + CONFIG.timerBusyRetrySeconds }).where(eq(sessionTimers.sessionId, sessionId)).run();
      sessionChanged(sessionId);
    };
    // A monitor session hands a failed re-check to a person. Any other session retries once, later, which covers a network
    // that is not up yet after the app wakes; a run already retries its model calls, so a second failure ends the follow-up.
    // A timer the run set again stays.
    const rearmOnFailure = ({ error }: { error?: string }) => {
      const key = `${sessionId}:${timer.setAt}`;
      if (!error) { retried.delete(key); return; }
      if (retried.has(key) || unixNow() >= timer.setAt + CONFIG.timerMaxAfterSessionSeconds) { retried.delete(key); return; }
      retried.add(key);
      const fireAt = unixNow() + REARM_DELAY_SECONDS;
      void (async () => {
        // The fired row can still be there; it is replaced, so the cleanup of fired rows cannot drop the re-arm.
        await db.insert(sessionTimers).values({ ...timer, fireAt })
          .onConflictDoUpdate({ target: sessionTimers.sessionId, set: { fireAt }, setWhere: isNull(sessionTimers.fireAt) }).run();
        sessionChanged(sessionId);
      })().catch((err) => console.error(`[timer] could not keep the follow-up for session ${sessionId}:`, err instanceof Error ? err.message : String(err)));
    };
    if (kind === SESSION_KIND.MONITOR && (await monitorStopped(db, sessionId) || await issuesEnded(db, sessionId))) {
      await dropTimer(db, sessionId);
      continue;
    }
    // Without a connected provider the run has no tools to check the alert; the re-check waits.
    if (context.activeStreams.has(sessionId) || !context.providers.getAllProviders().some((p) => p.connected)) {
      await retryLater();
      continue;
    }
    await db.update(sessionTimers).set({ fireAt: null }).where(eq(sessionTimers.sessionId, sessionId)).run();
    started++;
    let extras: Wakeup | undefined;
    try {
      extras = await wakeupExtras(context, sessionId);
      const at = (t: number) => formatLocalTime(t, tz);
      const result = await start(context, {
        sessionId,
        kind: (kind ?? SESSION_KIND.API) as SessionKind,
        provider: scope ?? undefined,
        message: [
          `${WAKEUP_MARK}set ${at(timer.setAt)}, due ${at(timer.fireAt!)}, now ${at(now)}): ${timer.note || "Scheduled re-check"}`,
          ...extras.lines,
        ].join("\n"),
        tools: extras.tools,
        onComplete: extras.onComplete ?? rearmOnFailure,
      });
      if ("error" in result) {
        await extras.revert?.();
        await retryLater();
        console.warn(`[timer] follow-up for session ${sessionId} not started:`, result.error);
      } else {
        // Keep a timer the woken run already set again.
        await db.delete(sessionTimers).where(and(eq(sessionTimers.sessionId, sessionId), isNull(sessionTimers.fireAt))).run();
        sessionChanged(sessionId);
      }
    } catch (err) {
      await extras?.revert?.();
      await retryLater();
      console.error(`[timer] follow-up for session ${sessionId} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}

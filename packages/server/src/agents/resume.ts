import { eq } from "drizzle-orm";
import { SESSION_KIND, unixNow } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { chatSessions } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import type { Context } from "../trpc/context.js";
import { loadSessionMessages, runChatAgent } from "./base-agent.js";
import { buildRunOptions } from "./chat-run.js";
import { isWakeupTurn, wakeupExtras } from "../monitors/triage.js";
import { settleMonitorRun } from "../monitors/scheduler.js";
import { CONFIG } from "../config.js";

export interface InterruptedRun {
  id: string;
  scope: string;
  kind: string | null;
}

async function markDone(db: Db, id: string): Promise<void> {
  await db.update(chatSessions).set({ status: "done", updatedAt: unixNow() }).where(eq(chatSessions.id, id)).run();
  sessionChanged(id);
}

/**
 * Settles the sessions a restart interrupted: each ends as done, except a run that was not
 * resumed before, has a scope to rebuild from and was saved recently. Those are returned.
 * The ids of ended monitor sessions are added to `settled`, for resumeRuns to close out.
 */
export async function settleInterruptedRuns(db: Db, settled: string[] = []): Promise<InterruptedRun[]> {
  const rows = await db
    .select({ id: chatSessions.id, kind: chatSessions.kind, scope: chatSessions.runScope, resumed: chatSessions.resumed, updatedAt: chatSessions.updatedAt })
    .from(chatSessions)
    .where(eq(chatSessions.status, "streaming"))
    .all();
  const runs: InterruptedRun[] = [];
  const cutoff = unixNow() - CONFIG.chatResumeMaxAgeSec;
  for (const { id, kind, scope, resumed, updatedAt } of rows) {
    if (scope && !resumed && updatedAt >= cutoff) runs.push({ id, scope, kind });
    else {
      await markDone(db, id);
      if (kind === SESSION_KIND.MONITOR) settled.push(id);
    }
  }
  return runs;
}

/** Continues each run from its last saved step, with no new user message. Needs the providers for the tools. */
export async function resumeRuns(context: Context, runs: InterruptedRun[], settled: string[] = []): Promise<void> {
  const failed = async (id: string, error: string) => {
    await markDone(context.db, id).catch(() => {});
    await settleMonitorRun(context, id, error);
  };
  await Promise.all([
    ...settled.map((id) => settleMonitorRun(context, id, "Interrupted by a restart")),
    ...runs.map(async ({ id, scope, kind }) => {
      try {
        const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, id);
        // A resumed wake-up gets the same tools and hooks as the timer gave it.
        const wake = kind === SESSION_KIND.MONITOR && isWakeupTurn(messages) ? await wakeupExtras(context, id) : null;
        const options = await buildRunOptions(context, { sessionId: id, kind, scope, extras: wake?.tools, onComplete: wake?.onComplete });
        const result = messages.length === 0
          ? { error: "Nothing to resume" }
          : await runChatAgent({ sessionId: id, messages, summary, summaryUpTo, context, resumed: true, ...options });
        if ("error" in result) await failed(id, result.error ?? "Could not resume");
      } catch (err) {
        console.warn(`[chat] Failed to resume ${id}:`, err);
        await failed(id, err instanceof Error ? err.message : String(err));
      }
    }),
  ]);
}

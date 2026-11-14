import { eq } from "drizzle-orm";
import type { UIMessage } from "ai";
import { SESSION_KIND, unixNow } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { chatSessions } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import { pendingResume } from "../lib/pending-resume.js";
import type { Context } from "../trpc/context.js";
import { loadSessionMessages, runChatAgent, SESSION_BUSY } from "./base-agent.js";
import { buildRunOptions } from "./chat-run.js";
import { isFiringTurn, isWakeupTurn, wakeupExtras } from "../monitors/triage.js";
import { settleMonitorRun } from "../monitors/scheduler.js";
import { CONFIG } from "../config.js";
import { errorLine } from "../lib/error-line.js";
import { endsWithAsk } from "../tools/ask-tool.js";

interface InterruptedRun {
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
 * `settled` holds the ids of ended monitor sessions, for resumeRuns to close out.
 */
export async function settleInterruptedRuns(db: Db): Promise<{ interrupted: InterruptedRun[]; settled: string[] }> {
  const rows = await db
    .select({ id: chatSessions.id, kind: chatSessions.kind, scope: chatSessions.runScope, resumed: chatSessions.resumed, updatedAt: chatSessions.updatedAt })
    .from(chatSessions)
    .where(eq(chatSessions.status, "streaming"))
    .all();
  const interrupted: InterruptedRun[] = [];
  const settled: string[] = [];
  const cutoff = unixNow() - CONFIG.chatResumeMaxAgeSec;
  for (const { id, kind, scope, resumed, updatedAt } of rows) {
    if (scope && !resumed && updatedAt >= cutoff) {
      interrupted.push({ id, scope, kind });
      pendingResume.add(id);
    }
    else {
      await markDone(db, id);
      if (kind === SESSION_KIND.MONITOR) settled.push(id);
    }
  }
  return { interrupted, settled };
}

/** True when a person started the interrupted turn of a monitor session: it began with neither the firing nor a wake-up. */
export function personTurn(kind: string | null, messages: UIMessage[]): boolean {
  return kind === SESSION_KIND.MONITOR && !isWakeupTurn(messages) && !isFiringTurn(messages);
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
        // The question ended the reply; the person's answer starts the next turn.
        if (endsWithAsk(messages)) {
          await markDone(context.db, id);
          // The restart cut off the run's completion hook, so a monitor run still owes its report.
          if (kind === SESSION_KIND.MONITOR) await settleMonitorRun(context, id, "Interrupted by a restart");
          return;
        }
        // A resumed wake-up gets the same tools and hooks as the timer gave it.
        const wake = kind === SESSION_KIND.MONITOR && isWakeupTurn(messages) ? await wakeupExtras(context, id) : null;
        // A person's own turn keeps the tools it had before the restart.
        const options = await buildRunOptions(context, { sessionId: id, kind, scope, interactive: personTurn(kind, messages), extras: wake?.tools, onComplete: wake?.onComplete });
        const result = messages.length === 0
          ? { error: "Nothing to resume" }
          : await runChatAgent({ sessionId: id, messages, summary, summaryUpTo, context, resumed: true, ...options });
        // Another run already owns the session (a timer or a person started it first): it is not interrupted.
        if ("error" in result && result.error !== SESSION_BUSY) await failed(id, result.error ?? "Could not resume");
      } catch (err) {
        console.warn(`[chat] Failed to resume ${id}:`, errorLine(err));
        await failed(id, err instanceof Error ? err.message : String(err));
      } finally {
        pendingResume.delete(id);
      }
    }),
  ]);
}

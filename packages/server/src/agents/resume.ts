import { eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { chatSessions } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import type { Context } from "../trpc/context.js";
import { loadSessionMessages, runChatAgent } from "./base-agent.js";
import { chatRunOptions, MONITOR_CHAT_SCOPE, monitorChatRunOptions } from "./chat-run.js";
import { CONFIG } from "../config.js";

export interface InterruptedRun {
  id: string;
  scope: string;
}

async function markDone(db: Db, id: string): Promise<void> {
  await db.update(chatSessions).set({ status: "done", updatedAt: unixNow() }).where(eq(chatSessions.id, id)).run();
  sessionChanged(id);
}

/**
 * Settles the sessions a restart interrupted: each ends as done, except a run that was not
 * resumed before, has a scope to rebuild from and was saved recently. Those are returned.
 */
export async function settleInterruptedRuns(db: Db): Promise<InterruptedRun[]> {
  const rows = await db
    .select({ id: chatSessions.id, scope: chatSessions.runScope, resumed: chatSessions.resumed, updatedAt: chatSessions.updatedAt })
    .from(chatSessions)
    .where(eq(chatSessions.status, "streaming"))
    .all();
  const runs: InterruptedRun[] = [];
  const cutoff = unixNow() - CONFIG.chatResumeMaxAgeSec;
  for (const { id, scope, resumed, updatedAt } of rows) {
    if (scope && !resumed && updatedAt >= cutoff) runs.push({ id, scope });
    else await markDone(db, id);
  }
  return runs;
}

/** Continues each run from its last saved step, with no new user message. Needs the providers for the tools. */
export async function resumeRuns(context: Context, runs: InterruptedRun[]): Promise<void> {
  await Promise.all(runs.map(async ({ id, scope }) => {
    try {
      const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, id);
      const options = scope === MONITOR_CHAT_SCOPE ? monitorChatRunOptions(context) : await chatRunOptions(context, id, scope);
      const result = messages.length === 0
        ? { error: "Nothing to resume" }
        : await runChatAgent({ sessionId: id, messages, summary, summaryUpTo, context, resumed: true, ...options });
      if ("error" in result) await markDone(context.db, id);
    } catch (err) {
      console.warn(`[chat] Failed to resume ${id}:`, err);
      await markDone(context.db, id).catch(() => {});
    }
  }));
}

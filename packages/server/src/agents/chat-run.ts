import { SESSION_KIND, UNIFIED_SCOPE, type ChatMode } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import type { ChatAgentConfig } from "./base-agent.js";
import { firstUserMessageTitle } from "./base-agent.js";
import { collectChatTools, withSessionTools } from "../tools/chat-tools.js";
import { collectMonitorTools } from "../tools/monitor-tools.js";
import { pastSessionToolFor } from "../monitors/repeats.js";
import { firingRerun } from "../monitors/scheduler.js";
import { CONFIG } from "../config.js";

export const MONITOR_CHAT_SCOPE = "__monitor_chat__";

type RunOptions = Pick<ChatAgentConfig, "collectTools" | "sessionTitle" | "retryDelaysMs" | "onFailed" | "scope">;

/** The tools and hooks of a chat run; `scope` is a provider name or the unified sentinel. A restart rebuilds the run from it. */
export async function chatRunOptions(context: Context, id: string, scope?: string): Promise<RunOptions> {
  // The chat toggle is the single source of truth for session scope: the unified sentinel
  // (or an omitted field) means "one agent with every connected provider's tools" (no
  // filter); any other value scopes to one provider (direct mode).
  const isUnified = !scope || scope === UNIFIED_SCOPE;
  const mode: ChatMode = isUnified ? "unified" : "direct";
  const scopedProvider = isUnified ? undefined : scope;
  // A monitor session whose run never reported (e.g. Retry after an error) still owes its triage and Slack post.
  const rerun = await firingRerun(context, id);

  return {
    scope: scope || UNIFIED_SCOPE,
    retryDelaysMs: CONFIG.chatRetryDelaysMs,
    collectTools: async (writer) => {
      const collected = await collectChatTools(context.providers, context.db, writer, scopedProvider, mode);
      const afterComplete: typeof collected.afterComplete = rerun
        ? (params) => { collected.afterComplete?.(params); rerun.onComplete({}); }
        : collected.afterComplete;
      if (!collected.tools) return { ...collected, afterComplete };
      const readPast = await pastSessionToolFor(context.db, id);
      return {
        ...collected,
        tools: withSessionTools(collected.tools, context.db, id, rerun ? SESSION_KIND.MONITOR : undefined, { ...(readPast ? { read_past_session: readPast } : {}), ...rerun?.tools }),
        afterComplete,
      };
    },
    sessionTitle: firstUserMessageTitle,
    onFailed: rerun ? (error) => rerun.onComplete({ error }) : undefined,
  };
}

export function monitorChatRunOptions(context: Context): RunOptions {
  return {
    scope: MONITOR_CHAT_SCOPE,
    retryDelaysMs: CONFIG.chatRetryDelaysMs,
    collectTools: (writer) => collectMonitorTools(context.providers, context.db, context.activeStreams, writer),
    sessionTitle: firstUserMessageTitle,
  };
}

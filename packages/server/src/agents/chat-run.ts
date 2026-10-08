import { SESSION_KIND, UNIFIED_SCOPE, type ChatMode, type SessionKind } from "@tracer-sh/shared";
import { eq } from "drizzle-orm";
import type { Context } from "../trpc/context.js";
import { chatSessions } from "../db/schema.js";
import type { ChatAgentConfig } from "./base-agent.js";
import { firstUserMessageTitle } from "./base-agent.js";
import { collectChatTools, withSessionTools } from "../tools/chat-tools.js";
import { collectMonitorTools } from "../tools/monitor-tools.js";
import { pastSessionToolFor } from "../monitors/repeats.js";
import { firingRerun } from "../monitors/scheduler.js";
import { CONFIG } from "../config.js";

export const MONITOR_CHAT_SCOPE = "__monitor_chat__";

type RunOptions = Pick<ChatAgentConfig, "collectTools" | "sessionTitle" | "retryDelaysMs" | "onFailed" | "scope">;

export interface RunSpec {
  sessionId: string;
  /** chat_sessions.kind. A monitor session loses the unscoped ack/close tools, also for a chat turn. */
  kind?: SessionKind | string | null;
  /** chat_sessions.runScope: a provider name, the unified sentinel or the monitor builder marker. */
  scope?: string | null;
  /** A person waits for this run: shorter retries than an unattended run. */
  interactive?: boolean;
  /** Extra tools for this run only. */
  extras?: Record<string, unknown>;
  /** Fires once after the run: when its messages are saved, or with the error when every attempt failed. */
  onComplete?: (outcome: { error?: string }) => void;
}

export function monitorChatRunOptions(context: Context): RunOptions {
  return {
    scope: MONITOR_CHAT_SCOPE,
    retryDelaysMs: CONFIG.chatRetryDelaysMs,
    collectTools: (writer) => collectMonitorTools(context.providers, context.db, context.activeStreams, writer),
    sessionTitle: firstUserMessageTitle,
  };
}

/** The one place that builds the tools, retries and hooks of a run: chat turns, API runs, firings, wake-ups and resumed runs. A restart rebuilds the run from its saved kind and scope. */
export async function buildRunOptions(context: Context, spec: RunSpec): Promise<RunOptions> {
  const { sessionId, kind, extras, interactive } = spec;
  const retryDelaysMs = interactive ? CONFIG.chatRetryDelaysMs : CONFIG.agentRetryDelaysMs;
  if (spec.scope === MONITOR_CHAT_SCOPE) return { ...monitorChatRunOptions(context), retryDelaysMs };

  const scope = spec.scope || UNIFIED_SCOPE;
  // The chat toggle is the single source of truth for session scope: the unified sentinel means one agent
  // with every connected provider's tools (no filter); any other value scopes to one provider (direct mode).
  const isUnified = scope === UNIFIED_SCOPE;
  const mode: ChatMode = isUnified ? "unified" : "direct";
  const scopedProvider = isUnified ? undefined : scope;
  const monitor = kind === SESSION_KIND.MONITOR;
  // A monitor session whose run never reported (e.g. Retry after an error) still owes its triage and Slack post.
  const rerun = spec.onComplete || !monitor ? null : await firingRerun(context, sessionId);
  const onComplete = spec.onComplete ?? rerun?.onComplete;

  return {
    scope,
    retryDelaysMs,
    collectTools: async (writer) => {
      const collected = await collectChatTools(context.providers, context.db, writer, scopedProvider, mode);
      const afterComplete: typeof collected.afterComplete = onComplete
        ? (params) => { collected.afterComplete?.(params); onComplete({}); }
        : collected.afterComplete;
      if (!collected.tools) return { ...collected, afterComplete };
      const readPast = await pastSessionToolFor(context.db, sessionId);
      return {
        ...collected,
        tools: withSessionTools(collected.tools, context.db, sessionId, (kind ?? undefined) as SessionKind | undefined, { ...(readPast ? { read_past_session: readPast } : {}), ...rerun?.tools, ...extras }, !interactive),
        afterComplete,
      };
    },
    sessionTitle: firstUserMessageTitle,
    onFailed: onComplete && ((error) => onComplete({ error })),
  };
}

/** The options of a chat turn: kind and scope come from the saved session, scope falls back to the toggle's value. */
export async function chatRunOptions(context: Context, id: string, scope?: string): Promise<RunOptions> {
  const row = await context.db.select({ kind: chatSessions.kind }).from(chatSessions).where(eq(chatSessions.id, id)).get();
  return buildRunOptions(context, { sessionId: id, kind: row?.kind, scope, interactive: true });
}

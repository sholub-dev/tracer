import type { UIMessage } from "ai";
import {
  UNIFIED_SCOPE,
  DEFAULT_SESSION_TITLE,
  unixNow,
  type ChatMode,
  type SessionKind,
} from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { chatSessions } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import { firstUserMessageTitle, loadSessionMessages, runChatAgent } from "./base-agent.js";
import { collectChatTools, withSessionTools } from "../tools/chat-tools.js";
import { generateSessionTitle } from "./utility/title.js";
import { CONFIG } from "../config.js";

export interface StartSessionOptions {
  sessionId: string;
  kind: SessionKind;
  message: string;
  /** Fixed title; skips AI title generation. */
  title?: string;
  /** Scope to one provider in direct mode; unified when omitted. */
  provider?: string;
  /** Fires once after the run: when its messages are persisted, or with the error when every attempt failed. */
  onComplete?: (outcome: { error?: string }) => void;
  /** Extra tools for this session only. */
  tools?: Record<string, unknown>;
}

export async function startAgentSession(
  context: Context,
  { sessionId, kind, message, title, provider, onComplete, tools }: StartSessionOptions,
): Promise<{ ok: true } | { error: string }> {
  // runChatAgent's upserts never touch `kind`, so it survives the run; resumed sessions keep theirs.
  const now = unixNow();
  await context.db
    .insert(chatSessions)
    .values({
      id: sessionId,
      title: title ?? DEFAULT_SESSION_TITLE,
      messages: "[]",
      status: "idle",
      kind,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  sessionChanged(sessionId);

  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: message }],
  };
  const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, sessionId, userMessage);

  if (!title && messages.length === 1) {
    generateSessionTitle(context.db, sessionId, message);
  }

  const isUnified = !provider || provider === UNIFIED_SCOPE;
  const mode: ChatMode = isUnified ? "unified" : "direct";
  const scopedProvider = isUnified ? undefined : provider;

  const result = await runChatAgent({
    sessionId,
    messages,
    summary,
    summaryUpTo,
    context,
    collectTools: async (writer) => {
      const collected = await collectChatTools(context.providers, context.db, writer, scopedProvider, mode);
      const orig = collected.afterComplete;
      return {
        ...collected,
        tools: collected.tools && withSessionTools(collected.tools, context.db, sessionId, kind, tools),
        afterComplete: (params) => {
          orig?.(params);
          onComplete?.({});
        },
      };
    },
    sessionTitle: firstUserMessageTitle,
    scope: provider || UNIFIED_SCOPE,
    retryDelaysMs: CONFIG.agentRetryDelaysMs,
    onFailed: (error) => onComplete?.({ error }),
  });

  return "error" in result ? { error: result.error ?? "Unknown error" } : { ok: true };
}

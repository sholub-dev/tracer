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
import { firstUserMessageTitle, loadSessionMessages, runChatAgent } from "./base-agent.js";
import { collectChatTools } from "../tools/chat-tools.js";
import { generateSessionTitle } from "./utility/title.js";

export interface StartSessionOptions {
  sessionId: string;
  kind: SessionKind;
  message: string;
  /** Fixed title; skips AI title generation. */
  title?: string;
  /** Scope to one provider in direct mode; unified when omitted. */
  provider?: string;
  /** Fires after the final messages are persisted. */
  onComplete?: () => void;
}

export async function startAgentSession(
  context: Context,
  { sessionId, kind, message, title, provider, onComplete }: StartSessionOptions,
): Promise<{ ok: true } | { error: string }> {
  // runChatAgent's upserts never touch `kind`, so it survives the run; resumed sessions keep theirs.
  const now = unixNow();
  context.db
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

  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: message }],
  };
  const { messages, summary, summaryUpTo } = loadSessionMessages(context.db, sessionId, userMessage);

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
    collectTools: (writer) => {
      const collected = collectChatTools(context.providers, context.db, writer, scopedProvider, mode);
      const orig = collected.afterComplete;
      return {
        ...collected,
        afterComplete: (params) => {
          orig?.(params);
          onComplete?.();
        },
      };
    },
    sessionTitle: firstUserMessageTitle,
  });

  return "error" in result ? { error: result.error ?? "Unknown error" } : { ok: true };
}

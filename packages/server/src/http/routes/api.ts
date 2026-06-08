import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { UIMessage } from "ai";
import {
  UNIFIED_SCOPE,
  SESSION_KIND,
  DEFAULT_SESSION_TITLE,
  CLIENT_TOOL_NAMES,
  unixNow,
  type ChatMode,
} from "@tracer-sh/shared";
import type { Context } from "../../trpc/context.js";
import { chatSessions } from "../../db/schema.js";
import { loadSessionMessages, runChatAgent } from "../../agents/base-agent.js";
import { collectChatTools } from "../../tools/chat-tools.js";
import { generateSessionTitle } from "../../agents/utility/title.js";
import { resolveSubAgentModel } from "../../llm/resolve.js";

interface MessagePart {
  type: string;
  text?: string;
  input?: { query?: string };
  output?: { parts?: Array<{ query?: string; results?: unknown }>; analysis?: string };
}

interface QueryRecord {
  tool: string;
  query: string;
  results: unknown;
}

/** Cap a single result payload so large timeseries don't bloat the response. */
const MAX_RESULT_CHARS = 4000;

/**
 * Render a provider query tool part (e.g. `tool-execute_nrql`) as a markdown
 * block, and push its query+results onto `queries`. These parts carry the actual
 * evidence (the executed query and its rows), so they belong in the analysis —
 * not just the prose around them.
 */
function renderToolPart(p: MessagePart, queries: QueryRecord[]): string {
  const tool = p.type.replace(/^tool-/, "");
  const queryParts = (p.output?.parts ?? []).filter((x) => typeof x?.query === "string");
  const blocks: string[] = [];

  for (const qp of queryParts) {
    const query = qp.query ?? p.input?.query ?? "";
    queries.push({ tool, query, results: qp.results });
    let resultStr: string;
    try {
      resultStr = JSON.stringify(qp.results);
    } catch {
      resultStr = String(qp.results);
    }
    if (resultStr.length > MAX_RESULT_CHARS) {
      resultStr = `${resultStr.slice(0, MAX_RESULT_CHARS)} …[truncated, full rows in queries]`;
    }
    blocks.push(`Query (${tool}):\n\`\`\`\n${query}\n\`\`\`\nResult:\n\`\`\`json\n${resultStr}\n\`\`\``);
  }

  // Tool produced no query parts (e.g. a non-query tool) — fall back to its summary.
  if (queryParts.length === 0 && p.output?.analysis) {
    const query = p.input?.query;
    if (query) queries.push({ tool, query, results: p.output.analysis });
    blocks.push(`Query (${tool}):${query ? `\n\`\`\`\n${query}\n\`\`\`` : ""}\nResult:\n${p.output.analysis}`);
  }

  return blocks.join("\n\n");
}

/**
 * Extract the final analysis from a completed session's messages.
 *
 * The agent marks its conclusion by calling the `begin_analysis` tool, persisted
 * as a part of type `tool-begin_analysis`. Everything after the last such marker
 * is the final Analysis: text interleaved with provider query tool parts. We
 * serialize both, in order, so the analysis includes the queries and their
 * results (not just the prose). If the agent answered without the marker, fall
 * back to the last assistant message's text. Also returns the queries as a
 * structured array for programmatic consumers.
 */
function extractAnalysis(messages: UIMessage[]): { analysis: string; queries: QueryRecord[] } {
  const assistantParts: MessagePart[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as MessagePart[]) assistantParts.push(p);
  }

  let markerIdx = -1;
  for (let i = assistantParts.length - 1; i >= 0; i--) {
    if (assistantParts[i].type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS) {
      markerIdx = i;
      break;
    }
  }

  const queries: QueryRecord[] = [];
  const segments: string[] = [];

  if (markerIdx >= 0) {
    for (const p of assistantParts.slice(markerIdx + 1)) {
      if (p.type === "text") {
        if (p.text?.trim()) segments.push(p.text);
      } else if (p.type.startsWith("tool-") && p.type !== CLIENT_TOOL_NAMES.BEGIN_ANALYSIS) {
        const block = renderToolPart(p, queries);
        if (block) segments.push(block);
      }
    }
  } else {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    for (const p of (lastAssistant?.parts as MessagePart[] | undefined) ?? []) {
      if (p.type === "text" && p.text?.trim()) segments.push(p.text);
    }
  }

  return { analysis: segments.join("\n\n").trim(), queries };
}

/**
 * Headless analysis API for other local agents (e.g. Claude Code). Runs the same
 * investigation agent as the web UI, but blocks until completion and returns only
 * the final analysis message as JSON. Sessions are tagged `kind: "api"` so they
 * appear in their own sidebar group and can be resumed by passing `sessionId`.
 */
export function registerApiRoutes(app: Hono, context: Context): void {
  app.post("/api/v1/analyze", async (c) => {
    let body: { message?: string; sessionId?: string; provider?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ status: "error", error: "invalid JSON body" }, 400);
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return c.json({ status: "error", error: "`message` is required" }, 400);
    }

    const sessionId = body.sessionId ?? crypto.randomUUID();

    // Tag brand-new sessions as `api` so they get their own sidebar group. The
    // upserts inside runChatAgent never touch `kind`, so this survives the run.
    // Resuming an existing session leaves its kind untouched.
    const existing = context.db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .get();
    if (!existing) {
      const now = unixNow();
      context.db
        .insert(chatSessions)
        .values({
          id: sessionId,
          title: DEFAULT_SESSION_TITLE,
          messages: "[]",
          status: "idle",
          kind: SESSION_KIND.API,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const userMessage: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: message }],
    };
    const messages = loadSessionMessages(context.db, sessionId, userMessage);

    // Generate an AI title on the first turn (fire-and-forget), like /api/chat.
    if (messages.length === 1) {
      generateSessionTitle(context.db, sessionId, message);
    }

    // Same scope logic as /api/chat: unified (all providers) by default; any other
    // provider value scopes to that single provider in direct mode.
    const isUnified = !body.provider || body.provider === UNIFIED_SCOPE;
    const mode: ChatMode = isUnified ? "unified" : "direct";
    const scopedProvider = isUnified ? undefined : body.provider;
    const modelOverride = mode === "direct" && scopedProvider
      ? resolveSubAgentModel(context.db, scopedProvider)
      : undefined;

    // Resolved by the wrapped afterComplete below, which fires after the final
    // messages have been persisted to the DB.
    let resolveDone: () => void = () => {};

    const result = await runChatAgent({
      sessionId,
      messages,
      context,
      collectTools: (writer) => {
        const collected = collectChatTools(context.providers, context.db, writer, scopedProvider, mode);
        const orig = collected.afterComplete;
        return {
          ...collected,
          afterComplete: (params) => {
            orig?.(params);
            resolveDone();
          },
        };
      },
      sessionTitle: (updatedMessages) => {
        const firstUserMsg = updatedMessages.find((m) => m.role === "user");
        const textPart = firstUserMsg?.parts.find((p) => p.type === "text");
        return textPart ? (textPart as { text: string }).text.slice(0, 60) : DEFAULT_SESSION_TITLE;
      },
      modelOverride: modelOverride && !("error" in modelOverride) ? modelOverride : undefined,
    });

    if ("error" in result) {
      const status = result.error === "Session is already processing a response" ? 409 : 400;
      return c.json({ sessionId, status: "error", error: result.error }, status);
    }

    // Wait for the run to complete. Fast path: resolveDone (the wrapped afterComplete)
    // fires only after the enriched messages are persisted, so it is safe to read the
    // DB immediately. Fallback: the session leaving activeStreams means the run ended
    // even when afterComplete never fires (error/abort path); the grace then lets any
    // in-flight success-path persistence land before we read, so we never return a
    // "done" status with an empty analysis. On success resolveDone wins long before the
    // grace elapses, so the grace only adds latency on the rare error path.
    const PERSIST_GRACE_MS = 2000;
    let pollHandle: ReturnType<typeof setInterval>;
    let graceHandle: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      resolveDone = resolve;
      pollHandle = setInterval(() => {
        if (!context.activeStreams.has(sessionId)) {
          clearInterval(pollHandle);
          graceHandle = setTimeout(resolve, PERSIST_GRACE_MS);
        }
      }, 200);
    });
    clearInterval(pollHandle!);
    clearTimeout(graceHandle);

    const row = context.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .get();

    let finalMessages: UIMessage[] = [];
    try {
      finalMessages = row ? (JSON.parse(row.messages) as UIMessage[]) : [];
    } catch {
      // fall through to empty
    }

    const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
    const usage = (lastAssistant as { usage?: unknown } | undefined)?.usage ?? null;
    const model = (usage as { model?: string } | null)?.model ?? null;

    const { analysis, queries } = extractAnalysis(finalMessages);

    return c.json({
      sessionId,
      status: row?.status ?? "done",
      analysis,
      queries,
      usage,
      model,
    });
  });
}

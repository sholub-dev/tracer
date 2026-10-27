import type { Hono } from "hono";
import { and, eq, gte, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import { SESSION_KIND, unixNow } from "@tracer-sh/shared";
import type { Context } from "../../trpc/context.js";
import { agentRuns, chatSessions } from "../../db/schema.js";
import { startAgentSession } from "../../agents/start-session.js";
import { extractAnalysis } from "../../agents/analysis.js";
import { decodeMessages } from "../../lib/messages-codec.js";

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
    const startedAt = unixNow();

    const result = await startAgentSession(context, {
      sessionId,
      kind: SESSION_KIND.API,
      message,
      provider: body.provider,
    });

    if ("error" in result) {
      const status = result.error === "Session is already processing a response" ? 409 : 400;
      return c.json({ sessionId, status: "error", error: result.error }, status);
    }

    // The broadcaster finishes only after final messages are persisted, on success, error and abort alike.
    const active = context.activeStreams.get(sessionId);
    if (active) await new Promise<void>((resolve) => active.broadcaster.onDone(resolve));

    const row = await context.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .get();

    let finalMessages: UIMessage[] = [];
    try {
      finalMessages = row ? decodeMessages(row.messages) : [];
    } catch {
      // fall through to empty
    }

    // Every model call of this request, retried attempts and the title included; the reply holds only its last attempt.
    const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
    const model = (lastAssistant as { usage?: { model?: string } } | undefined)?.usage?.model ?? null;
    const totals = await context.db
      .select({
        calls: sql<number>`COUNT(*)`,
        inputTokens: sql<number>`COALESCE(SUM(${agentRuns.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${agentRuns.outputTokens}), 0)`,
        reasoningTokens: sql<number>`COALESCE(SUM(${agentRuns.reasoningTokens}), 0)`,
        cachedInputTokens: sql<number>`COALESCE(SUM(${agentRuns.cachedInputTokens}), 0)`,
        cacheWriteTokens: sql<number>`COALESCE(SUM(${agentRuns.cacheWriteTokens}), 0)`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.sessionId, sessionId), gte(agentRuns.createdAt, startedAt)))
      .get();
    const { calls, ...tokens } = totals ?? { calls: 0 };
    const usage = calls > 0 ? { model, ...tokens } : null;

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

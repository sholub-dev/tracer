import type { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, sql } from "drizzle-orm";
import type { UIMessage } from "ai";
import { SESSION_KIND, unixNow } from "@tracer-sh/shared";
import type { Context } from "../../trpc/context.js";
import { agentRuns, chatSessions } from "../../db/schema.js";
import { SESSION_BUSY } from "../../agents/base-agent.js";
import { startAgentSession } from "../../agents/start-session.js";
import { extractAnalysis } from "../../agents/analysis.js";
import { decodeMessages } from "../../lib/messages-codec.js";

const MAX_MESSAGE_CHARS = 1_000_000;

const analyzeBody = z.object({
  message: z.string().max(MAX_MESSAGE_CHARS).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).refine((id) => !id.startsWith("__"), "reserved session id").nullish(),
  provider: z.string().nullish(),
});

/**
 * Headless analysis API for other local agents (e.g. Claude Code). Runs the same
 * investigation agent as the web UI, but blocks until completion and returns only
 * the final analysis message as JSON. Sessions are tagged `kind: "api"` so they
 * appear in their own sidebar group and can be resumed by passing `sessionId`.
 */
export function registerApiRoutes(app: Hono, context: Context): void {
  app.post("/api/v1/analyze", async (c) => {
    const parsed = analyzeBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ status: "error", error: "invalid request body" }, 400);
    }
    const body = parsed.data;
    const message = body.message?.trim() ?? "";
    if (!message) {
      return c.json({ status: "error", error: "`message` is required" }, 400);
    }

    const sessionId = body.sessionId ?? crypto.randomUUID();
    const startedAt = unixNow();

    const result = await startAgentSession(context, {
      sessionId,
      kind: SESSION_KIND.API,
      message,
      provider: body.provider ?? undefined,
    });

    if ("error" in result) {
      const status = result.error === SESSION_BUSY ? 409 : 400;
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

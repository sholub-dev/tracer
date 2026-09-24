import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { UIMessage } from "ai";
import { SESSION_KIND } from "@tracer-sh/shared";
import type { Context } from "../../trpc/context.js";
import { chatSessions } from "../../db/schema.js";
import { startAgentSession } from "../../agents/start-session.js";
import { extractAnalysis } from "../../agents/analysis.js";

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

    // Resolved by onComplete, which fires after the final messages have been persisted to the DB.
    let resolveDone: () => void = () => {};

    const result = await startAgentSession(context, {
      sessionId,
      kind: SESSION_KIND.API,
      message,
      provider: body.provider,
      onComplete: () => resolveDone(),
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

import type { Context as HonoContext, Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { SESSION_PREFIX, unixNow } from "@tracer-sh/shared";
import { chatSessions } from "../../db/schema.js";
import { sessionChanged } from "../../lib/session-events.js";
import type { Context } from "../../trpc/context.js";
import { loadSessionMessages, runChatAgent, SESSION_BUSY } from "../../agents/base-agent.js";
import { steerChat } from "../../agents/steer.js";
import { chatRunOptions, monitorChatRunOptions } from "../../agents/chat-run.js";
import { generateSessionTitle } from "../../agents/utility/title.js";
import { CONFIG } from "../../config.js";

/** A row still "streaming" that this process updated, with no run behind it: a run whose final write failed. Rows from before the start belong to the restart resume. */
const SERVER_START = unixNow();

type RunResult = Awaited<ReturnType<typeof runChatAgent>>;

/** Plain-text errors: the web client shows the body as the message. */
async function replyWithRun(c: HonoContext, start: () => Promise<RunResult | Response>): Promise<Response> {
  try {
    const result = await start();
    if (result instanceof Response) return result;
    if ("error" in result) return c.text(result.error ?? "The run could not start", result.error === SESSION_BUSY ? 409 : 400);
    return createUIMessageStreamResponse({ stream: result.stream });
  } catch (err) {
    console.error("[chat] Request failed:", err);
    return c.text(err instanceof Error && err.message ? err.message : "The request failed", 500);
  }
}

const steerBody = z.object({
  sessionId: z.string().min(1),
  message: z.object({
    id: z.string().min(1).optional(),
    metadata: z.object({ steered: z.boolean().optional() }).optional(),
    parts: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  }),
});

export function registerChatRoutes(app: Hono, context: Context): void {
  app.post("/api/chat", async (c) => {
    const { id, message, activeProvider } = await c.req.json<{ id: string; message: UIMessage; activeProvider?: string }>();
    return replyWithRun(c, async () => {
      if (context.activeStreams.has(id)) return c.text(SESSION_BUSY, 409);
      const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, id, message);
      const result = await runChatAgent({
        sessionId: id,
        messages,
        summary,
        summaryUpTo,
        context,
        ...await chatRunOptions(context, id, activeProvider),
      });

      // AI title on the first message (fire-and-forget); a rejected request makes no model call.
      if (!("error" in result) && messages.length === 1) {
        const textPart = message.parts?.find((p: { type: string }) => p.type === "text");
        if (textPart) {
          generateSessionTitle(context.db, id, (textPart as { text: string }).text);
        }
      }
      return result;
    });
  });

  app.post("/api/monitor-chat", async (c) => {
    const { id: sessionId, message } = await c.req.json<{ id?: string; message: UIMessage }>();
    if (typeof sessionId !== "string" || !sessionId.startsWith(SESSION_PREFIX.MONITORS)) {
      return c.text(`Monitor chat id must start with ${SESSION_PREFIX.MONITORS}`, 400);
    }
    return replyWithRun(c, async () => {
      const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, sessionId, message);
      return runChatAgent({
        sessionId,
        messages,
        summary,
        summaryUpTo,
        context,
        ...monitorChatRunOptions(context),
      });
    });
  });

  // Stop an active stream by session ID
  app.post("/api/chat/stop", async (c) => {
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    const active = context.activeStreams.get(sessionId);
    if (!active) return c.json({ stopped: false });
    active.controller.abort();
    return c.json({ stopped: true });
  });

  // Hand a user message to the active run; the agent reads it at its next step.
  app.post("/api/chat/steer", async (c) => {
    const body = steerBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.text("Invalid steer message", 400);
    const { sessionId, message } = body.data;
    // Whatever role and metadata the client sends, the model gets a steered user message: one without the mark would start a new turn once saved.
    const steered: UIMessage = { id: message.id ?? crypto.randomUUID(), role: "user", metadata: { ...message.metadata, steered: true }, parts: message.parts };
    return c.json({ steered: await steerChat(context, sessionId, steered) });
  });

  // Subscribe to an active stream via SSE (for reconnection after navigate-away)
  app.get("/api/chat/subscribe/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const active = context.activeStreams.get(sessionId);
    if (!active) {
      const row = await context.db.select({ status: chatSessions.status, updatedAt: chatSessions.updatedAt }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
      if (row?.status === "streaming" && row.updatedAt >= SERVER_START) {
        await context.db.update(chatSessions).set({ status: "done", updatedAt: unixNow() }).where(eq(chatSessions.id, sessionId)).run();
        sessionChanged(sessionId);
      }
      return c.json({ status: "not_streaming" }, 404);
    }

    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let unDone: () => void = () => {};
        const end = () => { clearInterval(heartbeat); unsub(); unDone(); resolve(); };
        const heartbeat = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "{}" }).catch(end);
        }, CONFIG.sseHeartbeatMs);
        const unsub = active.broadcaster.subscribe((part) => {
          stream.writeSSE({ event: "part", data: JSON.stringify(part) }).catch(end);
        });
        unDone = active.broadcaster.onDone(async () => {
          try { await stream.writeSSE({ event: "done", data: "{}" }); } catch {}
          end();
        });
        c.req.raw.signal.addEventListener("abort", end, { once: true });
      });
    });
  });
}

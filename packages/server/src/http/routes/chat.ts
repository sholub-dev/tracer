import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { dashboardSessionId, FEATURES, SESSION_PREFIX } from "@tracer-sh/shared";
import type { Context } from "../../trpc/context.js";
import { loadSessionMessages, runChatAgent } from "../../agents/base-agent.js";
import { chatRunOptions, monitorChatRunOptions } from "../../agents/chat-run.js";
import { collectDashboardTools } from "../../tools/dashboard-tools.js";
import { generateSessionTitle } from "../../agents/utility/title.js";
import { CONFIG } from "../../config.js";

export function registerChatRoutes(app: Hono, context: Context): void {
  app.post("/api/chat", async (c) => {
    const { id, message, activeProvider } = await c.req.json<{ id: string; message: UIMessage; activeProvider?: string }>();
    const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, id, message);

    // Generate AI title on the first message (fire-and-forget)
    if (messages.length === 1) {
      const textPart = message.parts?.find((p: { type: string }) => p.type === "text");
      if (textPart) {
        generateSessionTitle(context.db, id, (textPart as { text: string }).text);
      }
    }

    const result = await runChatAgent({
      sessionId: id,
      messages,
      summary,
      summaryUpTo,
      context,
      ...await chatRunOptions(context, id, activeProvider),
    });

    if ("error" in result) return c.json({ error: result.error }, 400);
    return createUIMessageStreamResponse({ stream: result.stream });
  });

  if (FEATURES.dashboards) app.post("/api/dashboard-chat", async (c) => {
    const { id, message, dashboardId } = await c.req.json<{ id: string; message: UIMessage; dashboardId: string }>();
    const sessionId = dashboardSessionId(dashboardId);
    const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, sessionId, message);

    const result = await runChatAgent({
      sessionId,
      messages,
      summary,
      summaryUpTo,
      context,
      retryDelaysMs: CONFIG.chatRetryDelaysMs,
      collectTools: (writer) => collectDashboardTools(context.providers, context.db, writer, dashboardId),
      sessionTitle: () => "Dashboard Builder",
    });

    if ("error" in result) return c.json({ error: result.error }, 400);
    return createUIMessageStreamResponse({ stream: result.stream });
  });

  app.post("/api/monitor-chat", async (c) => {
    const { id: sessionId, message } = await c.req.json<{ id?: string; message: UIMessage }>();
    if (typeof sessionId !== "string" || !sessionId.startsWith(SESSION_PREFIX.MONITORS)) {
      return c.json({ error: `Monitor chat id must start with ${SESSION_PREFIX.MONITORS}` }, 400);
    }
    const { messages, summary, summaryUpTo } = await loadSessionMessages(context.db, sessionId, message);

    const result = await runChatAgent({
      sessionId,
      messages,
      summary,
      summaryUpTo,
      context,
      ...monitorChatRunOptions(context),
    });

    if ("error" in result) return c.json({ error: result.error }, 400);
    return createUIMessageStreamResponse({ stream: result.stream });
  });

  // Stop an active stream by session ID
  app.post("/api/chat/stop", async (c) => {
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    const active = context.activeStreams.get(sessionId);
    if (!active) return c.json({ stopped: false });
    active.controller.abort();
    return c.json({ stopped: true });
  });

  // Subscribe to an active stream via SSE (for reconnection after navigate-away)
  app.get("/api/chat/subscribe/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const active = context.activeStreams.get(sessionId);
    if (!active) return c.json({ status: "not_streaming" }, 404);

    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        let unDone: () => void = () => {};
        const unsub = active.broadcaster.subscribe((part) => {
          stream.writeSSE({ event: "part", data: JSON.stringify(part) })
            .catch(() => { unsub(); unDone(); resolve(); });
        });
        unDone = active.broadcaster.onDone(async () => {
          try { await stream.writeSSE({ event: "done", data: "{}" }); } catch {}
          unsub(); unDone(); resolve();
        });
        c.req.raw.signal.addEventListener("abort", () => {
          unsub(); unDone(); resolve();
        }, { once: true });
      });
    });
  });
}

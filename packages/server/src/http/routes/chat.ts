import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { dashboardSessionId, SESSION_PREFIX, DEFAULT_SESSION_TITLE, DEFAULT_CHAT_MODE, type ChatMode } from "@tracer-sh/shared";
import type { Context } from "../../trpc/context.js";
import { loadSessionMessages, runChatAgent } from "../../agents/base-agent.js";
import { collectChatTools } from "../../tools/chat-tools.js";
import { collectDashboardTools } from "../../tools/dashboard-tools.js";
import { collectMonitorTools } from "../../tools/monitor-tools.js";
import { generateSessionTitle } from "../../agents/utility/title.js";
import { resolveSubAgentModel } from "../../llm/resolve.js";
import { readAppSetting } from "../../db/config-reader.js";
import { SETTINGS_KEYS } from "../../config.js";

export function registerChatRoutes(app: Hono, context: Context): void {
  app.post("/api/chat", async (c) => {
    const { id, message, activeProvider } = await c.req.json<{ id: string; message: UIMessage; activeProvider?: string }>();
    const messages = loadSessionMessages(context.db, id, message);

    // Generate AI title on the first message (fire-and-forget)
    if (messages.length === 1) {
      const textPart = message.parts?.find((p: { type: string }) => p.type === "text");
      if (textPart) {
        generateSessionTitle(context.db, id, (textPart as { text: string }).text);
      }
    }

    // In direct mode, use the sub-agent model for the active provider
    // instead of the default chat model.
    const mode = readAppSetting<ChatMode>(context.db, SETTINGS_KEYS.chatMode) ?? DEFAULT_CHAT_MODE;
    const modelOverride = mode === "direct" && activeProvider
      ? resolveSubAgentModel(context.db, activeProvider)
      : undefined;

    const result = await runChatAgent({
      sessionId: id,
      messages,
      context,
      collectTools: (writer) => collectChatTools(context.providers, context.db, writer, activeProvider),
      sessionTitle: (updatedMessages) => {
        const firstUserMsg = updatedMessages.find((m) => m.role === "user");
        const textPart = firstUserMsg?.parts.find((p) => p.type === "text");
        return textPart
          ? (textPart as { text: string }).text.slice(0, 60)
          : DEFAULT_SESSION_TITLE;
      },
      modelOverride: modelOverride && !("error" in modelOverride) ? modelOverride : undefined,
    });

    if ("error" in result) return c.json({ error: result.error }, 400);
    return createUIMessageStreamResponse({ stream: result.stream });
  });

  app.post("/api/dashboard-chat", async (c) => {
    const { id, message, dashboardId } = await c.req.json<{ id: string; message: UIMessage; dashboardId: string }>();
    const sessionId = dashboardSessionId(dashboardId);
    const messages = loadSessionMessages(context.db, sessionId, message);

    const result = await runChatAgent({
      sessionId,
      messages,
      context,
      collectTools: (writer) => collectDashboardTools(context.providers, context.db, writer, dashboardId),
      sessionTitle: () => "Dashboard Builder",
    });

    if ("error" in result) return c.json({ error: result.error }, 400);
    return createUIMessageStreamResponse({ stream: result.stream });
  });

  app.post("/api/monitor-chat", async (c) => {
    const { message } = await c.req.json<{ message: UIMessage }>();
    const sessionId = SESSION_PREFIX.MONITORS;
    const messages = loadSessionMessages(context.db, sessionId, message);

    const result = await runChatAgent({
      sessionId,
      messages,
      context,
      collectTools: (writer) => collectMonitorTools(context.providers, context.db, writer),
      sessionTitle: () => "Monitor Builder",
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

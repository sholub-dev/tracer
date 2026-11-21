import { TRPC_MAX_BATCH_SIZE } from "@tracer-sh/shared";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { bodyLimit } from "hono/body-limit";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "../trpc/router.js";
import { isOwnerRequest, markOwnerRequest, type Context } from "../trpc/context.js";
import { CONFIG } from "../config.js";
import { applyMiddleware } from "./middleware.js";
import { registerChatRoutes } from "./routes/chat.js";

const compression = compress();
const limitBody = bodyLimit({ maxSize: CONFIG.maxRequestBodyBytes, onError: (c) => c.text("Payload Too Large", 413) });

export function createApp(context: Context) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/chat")) return next();
    return compression(c, next);
  });
  applyMiddleware(app);
  app.use("/api/*", (c, next) => {
    // The body limit replaces the request object when the body has no Content-Length; the owner mark moves with it.
    const owner = isOwnerRequest(c.req.raw);
    return limitBody(c, async () => {
      if (owner) markOwnerRequest(c.req.raw);
      await next();
    });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  registerChatRoutes(app, context);

  app.use(
    "/api/trpc/*",
    trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      maxBatchSize: TRPC_MAX_BATCH_SIZE,
      createContext: (_opts, c) => ({ ...context, isOwner: isOwnerRequest(c.req.raw) }) as unknown as Record<string, unknown>,
    }),
  );

  return app;
}

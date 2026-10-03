import { Hono } from "hono";
import { compress } from "hono/compress";
import { trpcServer } from "@hono/trpc-server";
import { appRouter } from "../trpc/router.js";
import type { Context } from "../trpc/context.js";
import { applyMiddleware } from "./middleware.js";
import { registerChatRoutes } from "./routes/chat.js";

export function createApp(context: Context) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/chat")) return next();
    return compress()(c, next);
  });
  applyMiddleware(app);

  app.get("/health", (c) => c.json({ status: "ok" }));

  registerChatRoutes(app, context);

  app.use(
    "/api/trpc/*",
    trpcServer({
      endpoint: "/api/trpc",
      router: appRouter,
      createContext: () => context as unknown as Record<string, unknown>,
    }),
  );

  return app;
}

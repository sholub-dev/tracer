import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import { CONFIG } from "./config.js";
import { checkForUpdateBackground } from "./updater.js";
import { db } from "./db/client.js";
import { runSetup } from "./db/setup.js";
import { chatSessions } from "./db/schema.js";
import { ProviderRegistry } from "./providers/registry.js";
import { registerDefaultProviders } from "./providers/register-defaults.js";
import { createContext } from "./trpc/context.js";
import { createApp } from "./http/app.js";
import { MonitorScheduler } from "./monitors/scheduler.js";

export type { AppRouter } from "./trpc/router.js";

async function main() {
  checkForUpdateBackground();
  runSetup();

  // Mark stale "streaming" sessions from a previous crash as done
  db.update(chatSessions)
    .set({ status: "done", updatedAt: unixNow() })
    .where(eq(chatSessions.status, "streaming"))
    .run();

  const providers = new ProviderRegistry();
  registerDefaultProviders(providers);

  // Non-blocking — don't delay server startup for provider connections
  providers.initializeFromDb(db).then(() => {
    console.log("Providers initialized:", providers.getAllProviders().map((p) => p.name));
  }).catch((err) => {
    console.warn("Provider initialization error:", err);
  });

  const context = createContext({ db, providers });
  const app = createApp(context);

  const scheduler = new MonitorScheduler(db, providers);
  scheduler.start();

  const server = serve({ fetch: app.fetch, port: CONFIG.port }, (info) => {
    console.log(`Tracer server running on http://localhost:${info.port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${CONFIG.port} is already in use. Run: lsof -ti :${CONFIG.port} | xargs kill\n`);
    }
    process.exit(1);
  });

  const shutdown = async () => {
    const timeout = setTimeout(() => process.exit(1), CONFIG.shutdownGracePeriodMs);
    await scheduler.stop();
    for (const p of providers.getAllProviders()) {
      await p.dispose().catch(() => {});
    }
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
}

main().catch((err) => {
  console.error("Failed to start Tracer server:", err);
  process.exit(1);
});

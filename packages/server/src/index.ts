import "./node-version.js";
import { serve } from "@hono/node-server";
import { CONFIG } from "./config.js";
import { startUpdateChecks, setRestartHandler } from "./updater.js";
import { db, setupDriver } from "./db/client.js";
import { registerGcpProvider } from "./providers/gcp/register.js";
import { registerApiRoutes } from "./http/routes/api.js";
import { mountStaticFiles } from "./http/static.js";
import { guardLocalRequests } from "./http/local-guard.js";
import { startRuntime } from "./runtime.js";

export type { AppRouter } from "./trpc/router.js";

async function main() {
  startUpdateChecks();
  const { providers, context, app, scheduler } = await startRuntime(db, setupDriver, registerGcpProvider);
  registerApiRoutes(app, context);
  // Last: it answers every remaining GET with the web app.
  mountStaticFiles(app);

  // The Vite dev proxy keeps the browser's Origin; the built app serves the web app from this server (same origin).
  const allowedOrigins = [CONFIG.corsOrigin, ...(import.meta.url.endsWith(".ts") ? ["http://localhost:5173", "http://127.0.0.1:5173"] : [])]
    .filter((o): o is string => !!o);
  const fetch = guardLocalRequests(app.fetch, CONFIG.host, allowedOrigins);
  const server = serve({ fetch, port: CONFIG.port, hostname: CONFIG.host }, (info) => {
    console.log(`Tracer server running on http://localhost:${info.port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${CONFIG.port} is already in use. Run: lsof -ti :${CONFIG.port} | xargs kill\n`);
    }
    process.exit(1);
  });

  // The launcher forwards a signal the terminal already sent to this process, so the second one is ignored.
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // If graceful teardown stalls, force-exit — but preserve a non-zero restart
    // code so the launcher still respawns rather than treating it as a crash.
    const timeout = setTimeout(() => process.exit(code === 0 ? 1 : code), CONFIG.shutdownGracePeriodMs);
    await scheduler?.stop();
    for (const p of providers.getAllProviders()) {
      await p.dispose().catch(() => {});
    }
    clearTimeout(timeout);
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  process.on("SIGHUP", () => shutdown());
  // A successful self-update asks for a graceful restart: tear down cleanly
  // (dispose MCP subprocesses, stop the scheduler) then exit with the restart
  // code so the launcher re-spawns the freshly installed server.
  setRestartHandler(() => { void shutdown(CONFIG.restartExitCode); });
}

main().catch((err) => {
  console.error("Failed to start Tracer server:", err);
  process.exit(1);
});

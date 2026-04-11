import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { unixNow } from "@oko/shared";
import { checkForUpdateBackground } from "./updater.js";
import { db } from "./db/client.js";
import { runSetup } from "./db/setup.js";
import { chatSessions } from "./db/schema.js";
import { ProviderRegistry } from "./providers/registry.js";
import { NewRelicProvider } from "./providers/newrelic/newrelic.provider.js";
import { GcpProvider } from "./providers/gcp/gcp.provider.js";
import { McpProvider } from "./mcp/mcp-provider.js";
import { mcpDefinitions } from "./mcp/definitions.js";
import { createContext } from "./trpc/context.js";
import { createApp } from "./server.js";
import { MonitorScheduler } from "./monitors/scheduler.js";

export type { AppRouter } from "./trpc/router.js";

async function main() {
  // Check for updates in background (non-blocking, results exposed via tRPC)
  checkForUpdateBackground();

  // Run database setup
  runSetup();

  // Clean up stale "streaming" sessions from a previous crash/restart
  db.update(chatSessions)
    .set({ status: "done", updatedAt: unixNow() })
    .where(eq(chatSessions.status, "streaming"))
    .run();

  console.log("Database initialized.");

  // Set up provider registry
  const providers = new ProviderRegistry();

  // Register provider factories
  providers.registerFactory(
    "newrelic",
    (cfg) => {
      if (cfg.__mode === "mcp") {
        const def = mcpDefinitions.get("newrelic");
        if (!def) throw new Error('MCP definition for "newrelic" not found');
        return new McpProvider(def, cfg, "newrelic");
      }
      return new NewRelicProvider({
        type: "newrelic",
        apiKey: cfg.apiKey,
        accountId: cfg.accountId,
      });
    },
    {
      label: "New Relic",
      configFields: [
        { key: "apiKey", label: "API Key", type: "password" },
        { key: "accountId", label: "Account ID", type: "text" },
      ],
      modes: ["api", "mcp"],
      mcpConfigFields: [
        { key: "apiKey", label: "API Key", type: "password" },
        { key: "accountId", label: "Account ID", type: "text" },
        { key: "region", label: "Region (US or EU)", type: "text", required: false },
      ],
    },
  );

  providers.registerFactory(
    "gcp",
    (cfg) => {
      const def = mcpDefinitions.get("gcp");
      if (!def) throw new Error('MCP definition for "gcp" not found');
      return new GcpProvider(def, cfg);
    },
    {
      label: "Google Cloud",
      configFields: [],
    },
  );

  // Initialize providers in the background — don't block server startup
  providers.initializeFromDb(db).then(() => {
    console.log(
      "Providers initialized:",
      providers.getAllProviders().map((p) => p.name),
    );
  }).catch((err) => {
    console.warn("Provider initialization error:", err);
  });

  // Create tRPC context and Hono app
  const context = createContext({ db, providers });
  const app = createApp(context);

  // Start monitor scheduler
  const scheduler = new MonitorScheduler(db, providers);
  scheduler.start();

  // Start server
  const port = Number(process.env.OKO_PORT) || 3579;
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`OKO server running on http://localhost:${info.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    const timeout = setTimeout(() => process.exit(1), 5_000);
    await scheduler.stop();
    // Dispose all providers (cleans up MCP subprocesses)
    for (const p of providers.getAllProviders()) {
      await p.dispose().catch(() => {});
    }
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start OKO server:", err);
  process.exit(1);
});

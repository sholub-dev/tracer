import { eq } from "drizzle-orm";
import { FEATURES, unixNow } from "@tracer-sh/shared";
import type { Db, SetupDriver } from "./db/driver.js";
import { runSetup } from "./db/setup.js";
import { chatSessions } from "./db/schema.js";
import { ProviderRegistry } from "./providers/registry.js";
import { registerDefaultProviders } from "./providers/register-defaults.js";
import { createContext } from "./trpc/context.js";
import { createApp } from "./http/app.js";
import { MonitorScheduler } from "./monitors/scheduler.js";

/** Starts everything the desktop server and the in-app server share: schema, providers, context, routes, monitors. */
export async function startRuntime(
  db: Db,
  setupDriver: SetupDriver,
  registerPlatformProviders?: (providers: ProviderRegistry) => void,
) {
  await runSetup(setupDriver);

  // Mark stale "streaming" sessions from a previous crash as done
  await db.update(chatSessions)
    .set({ status: "done", updatedAt: unixNow() })
    .where(eq(chatSessions.status, "streaming"))
    .run();

  const providers = new ProviderRegistry();
  registerDefaultProviders(providers, registerPlatformProviders);

  // Non-blocking — don't delay server startup for provider connections
  providers.initializeFromDb(db).then(() => {
    console.log("Providers initialized:", providers.getAllProviders().map((p) => p.name));
  }).catch((err) => {
    console.warn("Provider initialization error:", err);
  });

  const context = createContext({ db, providers });
  const app = createApp(context);

  const scheduler = FEATURES.monitors ? new MonitorScheduler(context) : null;
  scheduler?.start();

  return { providers, context, app, scheduler };
}

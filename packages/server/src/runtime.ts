import { FEATURES } from "@tracer-sh/shared";
import type { Db, SetupDriver } from "./db/driver.js";
import { runSetup } from "./db/setup.js";
import { repairChats } from "./db/repair-chats.js";
import { settleInterruptedRuns, resumeRuns } from "./agents/resume.js";
import { ProviderRegistry } from "./providers/registry.js";
import { registerDefaultProviders } from "./providers/register-defaults.js";
import { createContext } from "./trpc/context.js";
import { createApp } from "./http/app.js";
import { maintainMemories } from "./agents/utility/memory-maintenance.js";
import { MonitorScheduler } from "./monitors/scheduler.js";

/** Starts everything the desktop server and the in-app server share: schema, providers, context, routes, monitors. */
export async function startRuntime(
  db: Db,
  setupDriver: SetupDriver,
  registerPlatformProviders?: (providers: ProviderRegistry) => void,
) {
  await runSetup(setupDriver);
  await repairChats(db, setupDriver);
  void maintainMemories(db);

  const settled: string[] = [];
  const interrupted = await settleInterruptedRuns(db, settled);

  const providers = new ProviderRegistry();
  registerDefaultProviders(providers, registerPlatformProviders);

  const context = createContext({ db, providers });

  // Non-blocking — don't delay server startup for provider connections; resumed runs need the provider tools
  const ready = providers.initializeFromDb(db).then(() => {
    console.log("Providers initialized:", providers.getAllProviders().map((p) => p.name));
  }).catch((err) => {
    console.warn("Provider initialization error:", err);
  }).then(() => resumeRuns(context, interrupted, settled));
  const app = createApp(context);

  const scheduler = FEATURES.monitors ? new MonitorScheduler(context) : null;
  scheduler?.start();

  return { providers, context, app, scheduler, ready };
}

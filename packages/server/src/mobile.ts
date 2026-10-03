import { createCapacitorDb, type CapacitorConnection } from "./db/capacitor-client.js";
import { setLlmFetch } from "./llm/resolve.js";
import { appRouter } from "./trpc/router.js";
import { startRuntime } from "./runtime.js";

export type { CapacitorConnection };
export { sessionChanges } from "./lib/session-events.js";

/** Starts the server inside the iOS app: no HTTP listener, no API v1, no static files, no GCP. */
export async function startMobileServer({ connection, llmFetch }: { connection: CapacitorConnection; llmFetch: typeof fetch }) {
  setLlmFetch(llmFetch);
  const { db, setupDriver } = createCapacitorDb(connection);
  await setupDriver.exec("PRAGMA foreign_keys = ON");
  const { context, app, scheduler } = await startRuntime(db, setupDriver);
  return {
    fetch: async (request: Request): Promise<Response> => app.fetch(request),
    router: appRouter,
    createContext: async () => context,
    scheduler,
    /** Agent runs in progress, monitor investigations included. */
    activeRuns: () => context.activeStreams.size,
  };
}

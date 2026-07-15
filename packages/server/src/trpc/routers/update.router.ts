import { publicProcedure, router } from "../trpc.js";
import { getUpdateStatus, performSelfUpdate, requestRestart } from "../../updater.js";

export const updateRouter = router({
  check: publicProcedure.query(() => {
    const status = getUpdateStatus();
    return {
      available: status.available,
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
      method: status.method,
      // Global and npx installs upgrade in place; only source checkouts can't.
      canSelfUpdate: status.method !== "dev",
    };
  }),

  // Upgrade a global install in place, then trigger a graceful restart so the
  // launcher re-spawns the new server. The restart is deferred to the next tick
  // so this response flushes to the client before shutdown begins.
  perform: publicProcedure.mutation(async () => {
    const result = await performSelfUpdate();
    if (result.ok) {
      setImmediate(() => requestRestart());
    }
    return result;
  }),
});

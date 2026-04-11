import { publicProcedure, router } from "../trpc.js";
import { getUpdateStatus, applyUpdate } from "../../updater.js";

export const updateRouter = router({
  check: publicProcedure.query(() => {
    const status = getUpdateStatus();
    return {
      available: status.available,
      currentVersion: status.currentVersion ?? "unknown",
      latestVersion: status.latestVersion,
    };
  }),

  install: publicProcedure.mutation(() => {
    applyUpdate();
    return { success: true };
  }),
});

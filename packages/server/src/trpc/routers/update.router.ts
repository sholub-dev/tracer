import { publicProcedure, router } from "../trpc.js";
import { getUpdateStatus } from "../../updater.js";

export const updateRouter = router({
  check: publicProcedure.query(() => {
    const status = getUpdateStatus();
    return {
      available: status.available,
      currentVersion: status.currentVersion,
      latestVersion: status.latestVersion,
    };
  }),
});

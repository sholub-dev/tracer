import { z } from "zod";
import { eq, desc, isNull } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { monitors, monitorAlerts } from "../../db/schema.js";

export const monitorsRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select()
      .from(monitors)
      .orderBy(desc(monitors.createdAt))
      .all();
  }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.db
        .select()
        .from(monitors)
        .where(eq(monitors.id, input.id))
        .get() ?? null;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      // CASCADE auto-deletes monitor_alerts
      ctx.db.delete(monitors).where(eq(monitors.id, input.id)).run();
      return { success: true };
    }),

  shouldPoll: publicProcedure.query(({ ctx }) => {
    const enabled = ctx.db
      .select({ id: monitors.id })
      .from(monitors)
      .where(eq(monitors.enabled, 1))
      .all();
    if (enabled.length === 0) return false;

    const paused = new Set(
      ctx.db
        .select({ monitorId: monitorAlerts.monitorId })
        .from(monitorAlerts)
        .where(isNull(monitorAlerts.resolvedAt))
        .all()
        .map((r) => r.monitorId),
    );
    return enabled.some((m) => !paused.has(m.id));
  }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.db.update(monitors)
        .set({ enabled: input.enabled ? 1 : 0, updatedAt: unixNow() })
        .where(eq(monitors.id, input.id))
        .run();
      return { success: true };
    }),
});

import { z } from "zod";
import { eq, isNull, desc, sql } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { monitorAlerts, monitors } from "../../db/schema.js";

export const monitorAlertsRouter = router({
  activeCount: publicProcedure.query(({ ctx }) => {
    const result = ctx.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(monitorAlerts)
      .where(isNull(monitorAlerts.resolvedAt))
      .get();
    return result?.count ?? 0;
  }),

  activeAlerts: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select({
        id: monitorAlerts.id,
        monitorId: monitorAlerts.monitorId,
        monitorName: monitors.name,
        triggeredAt: monitorAlerts.triggeredAt,
        resultSnapshot: monitorAlerts.resultSnapshot,
        createdAt: monitorAlerts.createdAt,
      })
      .from(monitorAlerts)
      .innerJoin(monitors, eq(monitorAlerts.monitorId, monitors.id))
      .where(isNull(monitorAlerts.resolvedAt))
      .orderBy(desc(monitorAlerts.triggeredAt))
      .all();
  }),

  listByMonitor: publicProcedure
    .input(z.object({ monitorId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.db
        .select()
        .from(monitorAlerts)
        .where(eq(monitorAlerts.monitorId, input.monitorId))
        .orderBy(desc(monitorAlerts.triggeredAt))
        .limit(50)
        .all();
    }),

  resolve: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      const alert = ctx.db
        .select({ monitorId: monitorAlerts.monitorId, resolvedAt: monitorAlerts.resolvedAt })
        .from(monitorAlerts)
        .where(eq(monitorAlerts.id, input.id))
        .get();
      if (!alert || alert.resolvedAt !== null) return { success: true };

      const now = unixNow();
      ctx.db
        .update(monitorAlerts)
        .set({ resolvedAt: now })
        .where(eq(monitorAlerts.id, input.id))
        .run();
      ctx.db
        .update(monitors)
        .set({ lastStatus: "ok", updatedAt: now })
        .where(eq(monitors.id, alert.monitorId))
        .run();
      return { success: true };
    }),
});

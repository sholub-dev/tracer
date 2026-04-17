import { z } from "zod";
import { eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { dashboardWidgets } from "../../db/schema.js";

export const widgetsRouter = router({
  list: publicProcedure
    .input(z.object({ dashboardId: z.string() }))
    .query(({ ctx, input }) => {
      const rows = ctx.db
        .select()
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.dashboardId, input.dashboardId))
        .all();
      return rows.map((w) => {
        let config: Record<string, unknown> = {};
        try {
          config = JSON.parse(w.config);
        } catch {
          console.warn(`[widgets] Corrupted config for widget "${w.id}"`);
        }
        return { ...w, config };
      });
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .delete(dashboardWidgets)
        .where(eq(dashboardWidgets.id, input.id))
        .run();
      return { success: true };
    }),

  move: publicProcedure
    .input(
      z.object({
        id: z.string(),
        posX: z.number(),
        posY: z.number(),
        posW: z.number(),
        posH: z.number(),
      }),
    )
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(dashboardWidgets)
        .set({
          posX: input.posX,
          posY: input.posY,
          posW: input.posW,
          posH: input.posH,
          updatedAt: unixNow(),
        })
        .where(eq(dashboardWidgets.id, input.id))
        .run();
      return { success: true };
    }),
});

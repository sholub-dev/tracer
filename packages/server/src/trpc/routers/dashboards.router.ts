import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { dashboardSessionId, unixNow } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { dashboards, chatSessions } from "../../db/schema.js";

export const dashboardsRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select()
      .from(dashboards)
      .orderBy(desc(dashboards.updatedAt))
      .all();
  }),

  create: publicProcedure
    .input(z.object({ title: z.string() }))
    .mutation(({ ctx, input }) => {
      const id = crypto.randomUUID();
      const now = unixNow();
      ctx.db
        .insert(dashboards)
        .values({ id, title: input.title, createdAt: now, updatedAt: now })
        .run();
      return { id, title: input.title };
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string(), title: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(dashboards)
        .set({ title: input.title, updatedAt: unixNow() })
        .where(eq(dashboards.id, input.id))
        .run();
      return { success: true };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.db.transaction((tx) => {
        // Dashboard chat session uses derived ID — not FK-able, must delete manually
        tx.delete(chatSessions).where(eq(chatSessions.id, dashboardSessionId(input.id))).run();
        // CASCADE auto-deletes dashboard_widgets
        tx.delete(dashboards).where(eq(dashboards.id, input.id)).run();
      });
      return { success: true };
    }),
});

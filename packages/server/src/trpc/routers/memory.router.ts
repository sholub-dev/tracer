import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { publicProcedure, router } from "../trpc.js";
import { toolMemories, memoryOperations } from "../../db/schema.js";
import { runMemoryOptimizer } from "../../agents/utility/memory-optimizer.js";

export const memoryRouter = router({
  bySession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ ctx, input }) => {
      return ctx.db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.sessionId, input.sessionId))
        .orderBy(memoryOperations.createdAt)
        .all();
    }),

  list: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select()
      .from(toolMemories)
      .orderBy(desc(toolMemories.createdAt))
      .all();
  }),

  create: publicProcedure
    .input(z.object({
      toolName: z.string().min(1),
      note: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .insert(toolMemories)
        .values({ toolName: input.toolName, note: input.note })
        .run();
      return { success: true };
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.number(),
        note: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(toolMemories)
        .set({ note: input.note })
        .where(eq(toolMemories.id, input.id))
        .run();
      return { success: true };
    }),

  remove: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .delete(toolMemories)
        .where(eq(toolMemories.id, input.id))
        .run();
      return { success: true };
    }),

  optimize: publicProcedure
    .input(z.object({ toolName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return runMemoryOptimizer(ctx.db, input.toolName);
    }),
});

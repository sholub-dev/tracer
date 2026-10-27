import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc } from "drizzle-orm";
import { publicProcedure, router } from "../trpc.js";
import { toolMemories, memoryOperations, chatSessions } from "../../db/schema.js";
import { countWords, createMemory, MAX_NOTE_WORDS, sanitizeNote } from "../../tools/memory-executor.js";
import { runMemoryOptimizer } from "../../agents/utility/memory-optimizer.js";

function checkLength(note: string) {
  if (countWords(note) > MAX_NOTE_WORDS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `The note is longer than ${MAX_NOTE_WORDS} words. Shorten it.` });
  }
}

export const memoryRouter = router({
  bySession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      return await ctx.db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.sessionId, input.sessionId))
        .orderBy(memoryOperations.createdAt)
        .all();
    }),

  list: publicProcedure.query(async ({ ctx }) => {
    return await ctx.db
      .select({
        id: toolMemories.id,
        toolName: toolMemories.toolName,
        note: toolMemories.note,
        reviewNote: toolMemories.reviewNote,
        source: toolMemories.source,
        sourceSessionId: toolMemories.sourceSessionId,
        sourceSessionTitle: chatSessions.title,
        lastUsedAt: toolMemories.lastUsedAt,
        createdAt: toolMemories.createdAt,
      })
      .from(toolMemories)
      .leftJoin(chatSessions, eq(chatSessions.id, toolMemories.sourceSessionId))
      .orderBy(desc(toolMemories.createdAt))
      .all();
  }),

  create: publicProcedure
    .input(z.object({
      toolName: z.string().min(1),
      note: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.toolName !== "unified" && !ctx.providers.getRegisteredTypes().some((t) => t.type === input.toolName)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown source: "${input.toolName}"` });
      }
      checkLength(sanitizeNote(input.note));
      const result = await createMemory(ctx.db, { toolName: input.toolName, note: input.note, source: "user" });
      if ("error" in result) throw new TRPCError({ code: "BAD_REQUEST", message: result.error });
      return { success: true };
    }),

  update: publicProcedure
    .input(
      z.object({
        id: z.number(),
        note: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const note = sanitizeNote(input.note);
      if (!note) throw new TRPCError({ code: "BAD_REQUEST", message: "The note is empty after cleanup" });
      checkLength(note);
      await ctx.db
        .update(toolMemories)
        .set({ note })
        .where(eq(toolMemories.id, input.id))
        .run();
      return { success: true };
    }),

  remove: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
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

import { z } from "zod";
import { eq, desc, notLike, and, or, ne, sql, isNull } from "drizzle-orm";
import {
  SESSION_PREFIX,
  SESSION_KIND,
  DEFAULT_SESSION_TITLE,
  unixNow,
  ImportedAnalysisSchema,
  CLIENT_TOOL_NAMES,
} from "@oko/shared";
import { publicProcedure, router } from "../trpc.js";
import { chatSessions, agentRuns } from "../../db/schema.js";

const AGENT_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  newrelic: "New Relic sub-agent",
  gcp: "GCP sub-agent",
  title: "Title gen",
  memory: "Memory",
};

export const sessionsRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        status: chatSessions.status,
        kind: chatSessions.kind,
        updatedAt: chatSessions.updatedAt,
      })
      .from(chatSessions)
      .where(and(
        notLike(chatSessions.id, `${SESSION_PREFIX.DASHBOARD}%`),
        notLike(chatSessions.id, `${SESSION_PREFIX.MONITORS}%`),
      ))
      .orderBy(desc(chatSessions.updatedAt))
      .all()
      .map(s => ({ ...s, titlePending: s.title === DEFAULT_SESSION_TITLE }));
  }),

  getTitle: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      const row = ctx.db
        .select({ title: chatSessions.title })
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      if (!row) return null;
      return { title: row.title, titlePending: row.title === DEFAULT_SESSION_TITLE };
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      const row = ctx.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      if (!row) return null;
      let messages: unknown[] = [];
      try {
        messages = JSON.parse(row.messages);
      } catch {
        console.warn(`[sessions] Corrupted messages for session ${row.id}`);
      }
      return {
        id: row.id, title: row.title, status: row.status, kind: row.kind, messages, updatedAt: row.updatedAt,
      };
    }),

  getCost: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      const rows = ctx.db
        .select({
          agentType: agentRuns.agentType,
          model: agentRuns.model,
          input: sql<number>`SUM(${agentRuns.inputTokens})`,
          output: sql<number>`SUM(${agentRuns.outputTokens})`,
          cached: sql<number>`SUM(${agentRuns.cachedInputTokens})`,
          cacheWrite: sql<number>`SUM(${agentRuns.cacheWriteTokens})`,
          reasoning: sql<number>`SUM(${agentRuns.reasoningTokens})`,
        })
        .from(agentRuns)
        .where(eq(agentRuns.sessionId, input.id))
        .groupBy(agentRuns.agentType, agentRuns.model)
        .all();

      const agents = rows.map((r) => ({
        label: AGENT_TYPE_LABELS[r.agentType] ?? r.agentType,
        model: r.model,
        input: r.input ?? 0,
        output: r.output ?? 0,
        cached: r.cached ?? 0,
        cacheWrite: r.cacheWrite ?? 0,
        reasoning: r.reasoning ?? 0,
      }));

      return { agents };
    }),

  activeCount: publicProcedure.query(({ ctx }) => {
    const rows = ctx.db
      .select({ status: chatSessions.status, count: sql<number>`count(*)` })
      .from(chatSessions)
      .where(and(
        notLike(chatSessions.id, `${SESSION_PREFIX.DASHBOARD}%`),
        notLike(chatSessions.id, `${SESSION_PREFIX.MONITORS}%`),
        or(isNull(chatSessions.kind), ne(chatSessions.kind, SESSION_KIND.IMPORTED)),
        or(
          eq(chatSessions.status, "streaming"),
          eq(chatSessions.status, "done"),
        ),
      ))
      .groupBy(chatSessions.status)
      .all();
    return {
      streaming: rows.find((r) => r.status === "streaming")?.count ?? 0,
      done: rows.find((r) => r.status === "done")?.count ?? 0,
    };
  }),

  markViewed: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      // Only transition "done" → "idle". Never overwrite "streaming" status.
      ctx.db
        .update(chatSessions)
        .set({ status: "idle" })
        .where(and(eq(chatSessions.id, input.id), ne(chatSessions.status, "streaming")))
        .run();
      return { success: true };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .delete(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .run();
      return { success: true };
    }),

  saveMessages: publicProcedure
    .input(z.object({ id: z.string(), messages: z.array(z.any()) }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(chatSessions)
        .set({
          messages: JSON.stringify(input.messages),
          updatedAt: unixNow(),
        })
        .where(eq(chatSessions.id, input.id))
        .run();
      return { success: true };
    }),

  importAnalysis: publicProcedure
    .input(ImportedAnalysisSchema)
    .mutation(({ ctx, input }) => {
      const id = crypto.randomUUID();
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        metadata: {
          sourceTitle: input.sourceTitle,
          sourceCreatedAt: input.sourceCreatedAt,
        },
        parts: [
          {
            type: CLIENT_TOOL_NAMES.BEGIN_ANALYSIS,
            toolCallId: crypto.randomUUID(),
            state: "output-available" as const,
            input: {},
            output: { status: "Analysis mode active." },
          },
          ...input.parts,
        ],
      };
      const title = input.sourceTitle.slice(0, 80) || DEFAULT_SESSION_TITLE;
      ctx.db
        .insert(chatSessions)
        .values({
          id,
          title,
          status: "idle",
          kind: SESSION_KIND.IMPORTED,
          messages: JSON.stringify([assistantMessage]),
        })
        .run();
      return { id };
    }),

  truncateMessages: publicProcedure
    .input(z.object({ id: z.string(), keepCount: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => {
      const row = ctx.db
        .select({ messages: chatSessions.messages })
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      if (!row) return { success: false };
      let messages: unknown[] = [];
      try {
        messages = JSON.parse(row.messages);
      } catch {
        return { success: false };
      }
      const truncated = messages.slice(0, input.keepCount);

      ctx.db
        .update(chatSessions)
        .set({
          messages: JSON.stringify(truncated),
          updatedAt: unixNow(),
        })
        .where(eq(chatSessions.id, input.id))
        .run();
      return { success: true };
    }),
});

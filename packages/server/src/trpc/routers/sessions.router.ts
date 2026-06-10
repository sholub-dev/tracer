import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, notLike, and, or, ne, sql, isNull } from "drizzle-orm";
import type { UIMessage } from "ai";
import {
  SESSION_PREFIX,
  SESSION_KIND,
  DEFAULT_SESSION_TITLE,
  unixNow,
  ImportedAnalysisSchema,
  CLIENT_TOOL_NAMES,
  compactionUpTo,
  isAnalysisMessage,
  splitAtAnalysis,
} from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { chatSessions, agentRuns } from "../../db/schema.js";
import { generateSessionSummary } from "../../agents/utility/summary.js";

const AGENT_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  newrelic: "New Relic sub-agent",
  gcp: "GCP sub-agent",
  posthog: "PostHog sub-agent",
  title: "Title gen",
  memory: "Memory",
  summary: "Compaction",
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
        summary: row.summary, summaryUpTo: row.summaryUpTo, summaryCreatedAt: row.summaryCreatedAt,
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
        // Imported sessions are read-only and API sessions are driven headlessly by
        // external agents — neither should drive the "unviewed done" nav badge.
        or(
          isNull(chatSessions.kind),
          and(
            ne(chatSessions.kind, SESSION_KIND.IMPORTED),
            ne(chatSessions.kind, SESSION_KIND.API),
          ),
        ),
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
        .select({ messages: chatSessions.messages, summaryUpTo: chatSessions.summaryUpTo })
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      if (!row) return { success: false, summaryCleared: false };
      let messages: unknown[] = [];
      try {
        messages = JSON.parse(row.messages);
      } catch {
        return { success: false, summaryCleared: false };
      }
      const truncated = messages.slice(0, input.keepCount);

      // A summary whose source prefix was truncated into no longer maps to the
      // history — clear it so full context is used again. A kept analysis
      // boundary stays visible at summaryUpTo but its working section fed the
      // summary, so the source range runs one past it: deleting that message
      // (keepCount === summaryUpTo) is also stale.
      const keptAnalysisBoundary =
        row.summaryUpTo != null &&
        isAnalysisMessage((messages[row.summaryUpTo] ?? { role: "" }) as Parameters<typeof isAnalysisMessage>[0]);
      const sourceUpTo = row.summaryUpTo != null ? row.summaryUpTo + (keptAnalysisBoundary ? 1 : 0) : 0;
      const summaryStale = row.summaryUpTo != null && input.keepCount < sourceUpTo;

      ctx.db
        .update(chatSessions)
        .set({
          messages: JSON.stringify(truncated),
          updatedAt: unixNow(),
          ...(summaryStale ? { summary: null, summaryUpTo: null, summaryCreatedAt: null } : {}),
        })
        .where(eq(chatSessions.id, input.id))
        .run();
      return { success: true, summaryCleared: summaryStale };
    }),

  compact: publicProcedure
    .input(z.object({ id: z.string(), upToIndex: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const row = ctx.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      if (row.status === "streaming" || ctx.activeStreams.has(input.id)) {
        throw new TRPCError({ code: "CONFLICT", message: "Cannot compact while a response is in progress" });
      }

      let messages: UIMessage[];
      try {
        messages = JSON.parse(row.messages);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Session messages are corrupted" });
      }

      const boundaryIdx = input.upToIndex;
      if (boundaryIdx >= messages.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Message not found in session" });
      }
      // Boundaries sit after a completed exchange — a user-message boundary
      // would split a request from its answer.
      if (messages[boundaryIdx].role !== "assistant") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Can only compact up to an assistant message" });
      }

      // An analysis boundary message stays visible — its distilled analysis
      // section is kept verbatim in the conversation. Its working section
      // (tool calls, intermediate text) is still folded into the summary, and
      // base-agent drops it from the model input in favor of the summary.
      const summaryUpTo = compactionUpTo(messages, boundaryIdx);
      if (summaryUpTo == null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "There are no messages to summarize before the analysis" });
      }
      const keptAnalysis = isAnalysisMessage(messages[boundaryIdx]);

      // Incremental re-compaction: when an earlier summary exists and the new
      // boundary is later, summarize prior summary + the delta segment.
      // Otherwise re-summarize everything from the originals.
      const incremental = !!row.summary && row.summaryUpTo != null && row.summaryUpTo < summaryUpTo;
      const segment = messages.slice(incremental ? row.summaryUpTo! : 0, boundaryIdx + 1);
      if (incremental) {
        // A kept-analysis boundary heading the delta was already folded into
        // the prior summary except for its analysis section — feed only that.
        const head = segment[0];
        if (isAnalysisMessage(head)) {
          const split = splitAtAnalysis(head.parts);
          if (split) segment[0] = { ...head, parts: split.analysis };
        }
      }
      if (keptAnalysis) {
        const last = segment[segment.length - 1];
        const split = splitAtAnalysis(last.parts);
        if (split) segment[segment.length - 1] = { ...last, parts: split.before };
      }
      const result = await generateSessionSummary(ctx.db, {
        sessionId: input.id,
        priorSummary: incremental ? row.summary! : undefined,
        messages: segment,
        keptAnalysis,
      });
      if ("error" in result) {
        throw new TRPCError({
          code: result.config ? "PRECONDITION_FAILED" : "INTERNAL_SERVER_ERROR",
          message: result.error,
        });
      }

      // The LLM call above can take a long time; re-validate before writing so
      // a truncation/edit/stream that landed mid-generation can't end up with a
      // summary boundary that no longer matches the stored history. A stream
      // that merely appended messages keeps the prefix intact and is fine.
      const fresh = ctx.db
        .select({ messages: chatSessions.messages, status: chatSessions.status })
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      // Guard everything the summary was built from. For an analysis boundary
      // summaryUpTo is boundaryIdx (the message stays visible), but its working
      // section fed the summary, so the source range runs through boundaryIdx+1.
      const sourceUpTo = boundaryIdx + 1;
      let prefixUnchanged = false;
      if (fresh && fresh.status !== "streaming" && !ctx.activeStreams.has(input.id)) {
        try {
          const freshMessages: UIMessage[] = JSON.parse(fresh.messages);
          prefixUnchanged =
            JSON.stringify(freshMessages.slice(0, sourceUpTo)) ===
            JSON.stringify(messages.slice(0, sourceUpTo));
        } catch { /* treat as changed */ }
      }
      if (!prefixUnchanged) {
        throw new TRPCError({ code: "CONFLICT", message: "The conversation changed while the summary was being generated — try again" });
      }

      const summary = result.summary;
      const summaryCreatedAt = unixNow();
      // Deliberately leaves updatedAt alone — compaction shouldn't reorder the sidebar.
      ctx.db
        .update(chatSessions)
        .set({ summary, summaryUpTo, summaryCreatedAt })
        .where(eq(chatSessions.id, input.id))
        .run();
      return { summary, summaryUpTo, summaryCreatedAt };
    }),

  updateSummary: publicProcedure
    .input(z.object({ id: z.string(), summary: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const row = ctx.db
        .select({ summaryUpTo: chatSessions.summaryUpTo })
        .from(chatSessions)
        .where(eq(chatSessions.id, input.id))
        .get();
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      // summary/summaryUpTo are written as a pair — never resurrect summary
      // text after the boundary was cleared (e.g. by a truncation elsewhere).
      if (row.summaryUpTo == null) {
        throw new TRPCError({ code: "CONFLICT", message: "The summary no longer exists" });
      }
      ctx.db
        .update(chatSessions)
        .set({ summary: input.summary })
        .where(eq(chatSessions.id, input.id))
        .run();
      return { success: true };
    }),

  clearSummary: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(chatSessions)
        .set({ summary: null, summaryUpTo: null, summaryCreatedAt: null })
        .where(eq(chatSessions.id, input.id))
        .run();
      return { success: true };
    }),
});

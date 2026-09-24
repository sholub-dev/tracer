import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, asc, desc, and, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { SESSION_KIND, unixNow } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { chatSessions, monitors, monitorTriggers } from "../../db/schema.js";
import { CONFIG } from "../../config.js";
import { MONITOR_PROVIDERS, normalizeDraft, validateMonitor } from "../../monitors/validate.js";
import { parseTriggerGroups } from "../../monitors/repeats.js";

const unreadSession = and(eq(chatSessions.kind, SESSION_KIND.MONITOR), eq(chatSessions.status, "done"));

export const monitorsRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    // User's saved order first; monitors created since then go at the end, oldest first.
    const rows = ctx.db.select().from(monitors)
      .orderBy(sql`${monitors.sortOrder} IS NULL`, asc(monitors.sortOrder), asc(monitors.createdAt)).all();
    const unread = new Map(
      ctx.db
        .select({ monitorId: monitorTriggers.monitorId, count: sql<number>`COUNT(DISTINCT ${chatSessions.id})` })
        .from(monitorTriggers)
        .innerJoin(chatSessions, eq(monitorTriggers.sessionId, chatSessions.id))
        .where(unreadSession)
        .groupBy(monitorTriggers.monitorId)
        .all()
        .map((r) => [r.monitorId, r.count]),
    );
    const lag = CONFIG.monitorIngestLagSeconds;
    // lastCheckedAt is the end of the last checked window; checks run `lag` seconds after it.
    return rows.map((m) => ({
      ...m,
      unreadCount: unread.get(m.id) ?? 0,
      lastRunAt: m.lastCheckedAt === null ? null : m.lastCheckedAt + lag,
    }));
  }),

  save: publicProcedure
    .input(z.object({
      chatSessionId: z.string(),
      name: z.string().min(1),
      provider: z.enum(MONITOR_PROVIDERS).default("newrelic"),
      query: z.string().min(1),
      chartQuery: z.string().nullish(),
      condition: z.string().min(1),
      frequencySeconds: z.number(),
    }))
    .mutation(async ({ ctx, input }) => {
      const draft = normalizeDraft(input);
      const validation = await validateMonitor(ctx.providers, draft);
      if ("error" in validation) throw new TRPCError({ code: "BAD_REQUEST", message: validation.error });

      const now = unixNow();
      const fields = {
        name: draft.name,
        provider: draft.provider,
        query: draft.query,
        chartQuery: draft.chartQuery,
        condition: draft.condition,
        frequencySeconds: draft.frequencySeconds,
        updatedAt: now,
      };
      const existing = ctx.db.select().from(monitors).where(eq(monitors.chatSessionId, input.chatSessionId)).get();
      if (existing) {
        return ctx.db.update(monitors).set(fields).where(eq(monitors.id, existing.id)).returning().get();
      }
      return ctx.db.insert(monitors).values({
        ...fields,
        id: crypto.randomUUID(),
        enabled: 1,
        lastStatus: "ok",
        chatSessionId: input.chatSessionId,
        createdAt: now,
      }).returning().get();
    }),

  reorder: publicProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      ctx.db.transaction((tx) => {
        input.ids.forEach((id, i) => tx.update(monitors).set({ sortOrder: i }).where(eq(monitors.id, id)).run());
      });
      return { success: true };
    }),

  setCardWidth: publicProcedure
    .input(z.object({ id: z.string(), width: z.union([z.literal(50), z.literal(75), z.literal(100)]) }))
    .mutation(({ ctx, input }) => {
      ctx.db.update(monitors).set({ cardWidth: input.width }).where(eq(monitors.id, input.id)).run();
      return { success: true };
    }),

  setAlertEnabled: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const updated = ctx.db.update(monitors)
        .set({ alertEnabled: input.enabled ? 1 : 0, updatedAt: unixNow() })
        .where(eq(monitors.id, input.id))
        .returning({ id: monitors.id })
        .get();
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Monitor not found" });
      return { success: true };
    }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const updated = ctx.db.update(monitors)
        .set({
          enabled: input.enabled ? 1 : 0,
          updatedAt: unixNow(),
          // Re-enabled monitors resume from now instead of checking the whole paused period.
          ...(input.enabled ? { lastCheckedAt: null } : {}),
        })
        .where(eq(monitors.id, input.id))
        .returning({ id: monitors.id })
        .get();
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Monitor not found" });
      return { success: true };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      const monitor = ctx.db.select().from(monitors).where(eq(monitors.id, input.id)).get();
      if (!monitor) throw new TRPCError({ code: "NOT_FOUND", message: "Monitor not found" });

      const sessionIds = ctx.db
        .select({ sessionId: monitorTriggers.sessionId })
        .from(monitorTriggers)
        .where(and(eq(monitorTriggers.monitorId, input.id), isNotNull(monitorTriggers.sessionId)))
        .all()
        .map((r) => r.sessionId as string);
      if (sessionIds.some((id) => ctx.activeStreams.has(id))) {
        throw new TRPCError({ code: "CONFLICT", message: "A session for this monitor is still running. Stop it first." });
      }

      const toDelete = [...new Set(monitor.chatSessionId ? [...sessionIds, monitor.chatSessionId] : sessionIds)];
      ctx.db.transaction((tx) => {
        if (toDelete.length > 0) tx.delete(chatSessions).where(inArray(chatSessions.id, toDelete)).run();
        tx.delete(monitors).where(eq(monitors.id, input.id)).run();
      });
      return { success: true };
    }),

  triggers: publicProcedure
    .input(z.object({ monitorId: z.string(), sinceSeconds: z.number().positive() }))
    .query(({ ctx, input }) => {
      return ctx.db
        .select({
          id: monitorTriggers.id,
          monitorId: monitorTriggers.monitorId,
          triggeredAt: monitorTriggers.triggeredAt,
          value: monitorTriggers.value,
          windowStart: monitorTriggers.windowStart,
          windowEnd: monitorTriggers.windowEnd,
          status: monitorTriggers.status,
          groups: monitorTriggers.groups,
          sessionId: monitorTriggers.sessionId,
          sessionTitle: chatSessions.title,
          sessionStatus: chatSessions.status,
        })
        .from(monitorTriggers)
        .leftJoin(chatSessions, eq(monitorTriggers.sessionId, chatSessions.id))
        .where(and(
          eq(monitorTriggers.monitorId, input.monitorId),
          gt(monitorTriggers.triggeredAt, unixNow() - input.sinceSeconds),
        ))
        .orderBy(desc(monitorTriggers.triggeredAt))
        .all()
        .map((t) => ({ ...t, groups: parseTriggerGroups(t.groups) }));
    }),

  sessions: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        status: chatSessions.status,
        updatedAt: chatSessions.updatedAt,
        monitorId: monitorTriggers.monitorId,
      })
      .from(monitorTriggers)
      .innerJoin(chatSessions, eq(monitorTriggers.sessionId, chatSessions.id))
      .orderBy(desc(monitorTriggers.triggeredAt))
      .limit(100)
      .all();
  }),

  unreadCount: publicProcedure.query(({ ctx }) => {
    const row = ctx.db
      .select({ count: sql<number>`COUNT(DISTINCT ${chatSessions.id})` })
      .from(chatSessions)
      .innerJoin(monitorTriggers, eq(monitorTriggers.sessionId, chatSessions.id))
      .where(unreadSession)
      .get();
    return row?.count ?? 0;
  }),
});

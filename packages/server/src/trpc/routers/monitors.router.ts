import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, asc, desc, and, gt, like, sql } from "drizzle-orm";
import { SESSION_KIND, SESSION_PREFIX, unixNow } from "@tracer-sh/shared";
import { publicProcedure, router } from "../trpc.js";
import { chatSessions, monitors, monitorTriggers } from "../../db/schema.js";
import { CONFIG } from "../../config.js";
import { parseTriggerGroups } from "../../monitors/repeats.js";
import { deleteMonitor, setMonitorToggles } from "../../monitors/store.js";

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
      const result = setMonitorToggles(ctx.db, input.id, { alert: input.enabled });
      if ("error" in result) throw new TRPCError({ code: result.code, message: result.error });
      return { success: true };
    }),

  toggleEnabled: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      const result = setMonitorToggles(ctx.db, input.id, { run: input.enabled });
      if ("error" in result) throw new TRPCError({ code: result.code, message: result.error });
      return { success: true };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      const result = deleteMonitor(ctx.db, ctx.activeStreams, input.id);
      if ("error" in result) throw new TRPCError({ code: result.code, message: result.error });
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

  builderChats: publicProcedure.query(({ ctx }) => {
    return ctx.db
      .select({ id: chatSessions.id, title: chatSessions.title, status: chatSessions.status, updatedAt: chatSessions.updatedAt })
      .from(chatSessions)
      .where(like(chatSessions.id, `${SESSION_PREFIX.MONITORS}%`))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(100)
      .all();
  }),
});

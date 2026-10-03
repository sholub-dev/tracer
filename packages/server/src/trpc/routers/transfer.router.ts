import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";
import { getSetting } from "../../transfer/peer.js";
import { inspectCopy, receiveCopy } from "../../transfer/receive.js";

// Loaded on demand: it opens a network listener, which only the desktop server can do.
const sender = () => import("../../transfer/send.js");

export const transferRouter = router({
  send: publicProcedure.mutation(async ({ ctx }) => (await sender()).startSend(ctx.db, () => ctx.activeStreams.size, async (providersChanged) => {
    if (providersChanged) await ctx.providers.reloadFromDb(ctx.db);
  })),
  sendStatus: publicProcedure.query(async () => (await sender()).sendStatus()),
  approve: publicProcedure.mutation(async () => {
    try { (await sender()).approve(); } catch (err) { throw new TRPCError({ code: "CONFLICT", message: (err as Error).message }); }
  }),
  deny: publicProcedure.mutation(async () => {
    try { (await sender()).deny(); } catch (err) { throw new TRPCError({ code: "CONFLICT", message: (err as Error).message }); }
  }),
  cancelSend: publicProcedure.mutation(async () => { (await sender()).stopSend(); }),

  lastSync: publicProcedure.query(async ({ ctx }) => {
    const at = Number(await getSetting(ctx.db, "sync_last_at"));
    return at ? { name: (await getSetting(ctx.db, "sync_peer_name")) ?? "", at } : null;
  }),

  inspect: publicProcedure.input(z.object({ link: z.string() })).query(async ({ ctx, input }) => {
    try {
      return await inspectCopy(ctx.db, input.link);
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
    }
  }),

  receive: publicProcedure.input(z.object({ link: z.string() })).mutation(async ({ ctx, input }) => {
    const assertIdle = () => {
      if (ctx.activeStreams.size > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "An investigation is running. Stop it or wait for it to finish, then scan again." });
      }
    };
    assertIdle();
    try {
      // Checked again after the download: a monitor or timer can start a run while the copy arrives.
      return await receiveCopy(ctx.db, input.link, assertIdle);
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
    }
  }),
});

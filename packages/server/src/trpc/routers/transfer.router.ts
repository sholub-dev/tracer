import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ownerProcedure, router } from "../trpc.js";
import { clearPairings, getPairing, getSetting, hasPairings, syncOff } from "../../transfer/peer.js";
import { cancelReceive, inspectCopy, receiveStatus, startReceive } from "../../transfer/receive.js";

// Loaded on demand: it opens a network listener, which only the desktop server can do.
const sender = () => import("../../transfer/send.js");

const receiverProcedure = ownerProcedure.use(({ ctx, next }) => {
  if (!ctx.receivesCopy) throw new TRPCError({ code: "FORBIDDEN", message: "This device does not receive a copy." });
  return next();
});

export const transferRouter = router({
  /** False on a server that must not open the sync listener. */
  sendEnabled: ownerProcedure.query(() => !syncOff()),
  send: ownerProcedure.mutation(async ({ ctx }) => (await sender()).startSend(ctx.db, () => ctx.activeStreams.size, async (providersChanged) => {
    if (providersChanged) await ctx.providers.reloadFromDb(ctx.db);
  })),
  sendStatus: ownerProcedure.query(async () => (await sender()).sendStatus()),
  approve: ownerProcedure.mutation(async () => {
    try { (await sender()).approve(); } catch (err) { throw new TRPCError({ code: "CONFLICT", message: (err as Error).message }); }
  }),
  deny: ownerProcedure.mutation(async () => {
    try { (await sender()).deny(); } catch (err) { throw new TRPCError({ code: "CONFLICT", message: (err as Error).message }); }
  }),
  cancelSend: ownerProcedure.mutation(async () => { (await sender()).stopSend(); }),

  lastSync: ownerProcedure.query(async ({ ctx }) => {
    const at = Number(await getSetting(ctx.db, "sync_last_at"));
    if (!at) return null;
    const peer = await getSetting(ctx.db, "sync_peer_id");
    // On the phone: true while it holds the pairing with the computer it synced with last. On the computer: true while any phone is paired.
    const paired = ctx.receivesCopy ? !!peer && !!(await getPairing(ctx.db, peer)) : await hasPairings(ctx.db);
    return { name: (await getSetting(ctx.db, "sync_peer_name")) ?? "", at, paired };
  }),
  /** The next sync of each paired device is a first sync: it replaces the data on the phone. */
  forgetPairings: ownerProcedure.mutation(({ ctx }) => clearPairings(ctx.db)),

  inspect: receiverProcedure.input(z.object({ link: z.string() })).query(async ({ ctx, input }) => {
    try {
      return await inspectCopy(ctx.db, input.link);
    } catch (err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
    }
  }),

  /** Starts the sync and returns at once; `receiveStatus` shows how it goes. */
  receive: receiverProcedure.input(z.object({ link: z.string() })).mutation(async ({ ctx, input }) => {
    const assertIdle = () => {
      if (ctx.activeStreams.size > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "An investigation is running. Stop it or wait for it to finish, then scan again." });
      }
    };
    assertIdle();
    try {
      // Checked again after the download: a monitor or timer can start a run while the data arrives.
      const { done, session } = await startReceive(ctx.db, input.link, assertIdle);
      // The failure is part of the status.
      done.catch(() => undefined);
      return session;
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
    }
  }),
  receiveStatus: receiverProcedure.query(() => receiveStatus()),
  cancelReceive: receiverProcedure.mutation(() => cancelReceive()),
});

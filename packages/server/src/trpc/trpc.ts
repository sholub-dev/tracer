import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // The iOS app runs this router inside the WebView.
  allowOutsideOfServer: true,
  // Keeps idle subscription streams alive through proxies; the client reconnects if pings stop.
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 20_000 } },
});

export const router = t.router;
export const publicProcedure = t.procedure;

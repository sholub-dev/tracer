import { initTRPC } from "@trpc/server";
import { ZodError } from "zod";
import superjson from "superjson";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // A ZodError message is raw JSON; clients show the first issue instead.
  errorFormatter({ shape, error }) {
    if (!(error.cause instanceof ZodError)) return shape;
    const issue = error.cause.issues[0];
    const field = issue?.path.join(".");
    return { ...shape, message: issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Invalid input" };
  },
  // The iOS app runs this router inside the WebView.
  allowOutsideOfServer: true,
  // Keeps idle subscription streams alive through proxies; the client reconnects if pings stop.
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 20_000 } },
});

export const router = t.router;
export const publicProcedure = t.procedure;

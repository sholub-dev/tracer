import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { z } from "zod";
import { publicProcedure, router } from "./trpc.js";

const appRouter = router({
  save: publicProcedure.input(z.object({ steps: z.number().min(1) })).mutation(() => "ok"),
});

test("a validation failure reads as one field message, not JSON", async () => {
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    router: appRouter,
    createContext: () => ({}) as never,
    req: new Request("http://x/trpc/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(superjson.serialize({ steps: 0 })),
    }),
  });
  const body = (await res.json()) as { error: { json: { message: string } } };
  assert.match(body.error.json.message, /^steps: /);
  assert.ok(!body.error.json.message.includes("["));
});

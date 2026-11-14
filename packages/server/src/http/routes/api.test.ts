import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { Hono } from "hono";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { ProviderRegistry } from "../../providers/registry.js";
import type { Context } from "../../trpc/context.js";
import { registerApiRoutes } from "./api.js";

async function setup() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const context: Context = { db, providers: new ProviderRegistry(), activeStreams: new Map() };
  const app = new Hono();
  registerApiRoutes(app, context);
  return async (body: unknown) => {
    const res = await app.request("/api/v1/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { error?: string; sessionId?: string } };
  };
}

test("analyze refuses an oversized message and a session id with an unexpected shape", async () => {
  const post = await setup();
  const invalid = { status: 400, body: { status: "error", error: "invalid request body" } };
  assert.deepEqual(await post({ message: "x".repeat(1_000_001) }), invalid);
  for (const sessionId of ["../x", "a b", "a/b", "__monitors__1", "x".repeat(129), ""]) {
    assert.deepEqual(await post({ message: "why?", sessionId }), invalid, sessionId);
  }
});

test("analyze accepts a UUID session id and a long message", async () => {
  const post = await setup();
  const sessionId = crypto.randomUUID();
  // The schema passes; the run then stops at the missing model key.
  const res = await post({ message: "x".repeat(100_000), sessionId });
  assert.equal(res.body.sessionId, sessionId);
  assert.match(res.body.error ?? "", /api key not configured/i);
});

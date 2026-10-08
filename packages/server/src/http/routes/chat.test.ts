import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3-multiple-ciphers";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { chatSessions, providerConfigs } from "../../db/schema.js";
import { writeAppSetting } from "../../db/config-reader.js";
import { SETTINGS_KEYS } from "../../config.js";
import { ProviderRegistry } from "../../providers/registry.js";
import { StreamBroadcaster } from "../../lib/stream-broadcaster.js";
import type { Context } from "../../trpc/context.js";
import { registerChatRoutes } from "./chat.js";

async function setup() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const context: Context = { db, providers: new ProviderRegistry(), activeStreams: new Map() };
  const app = new Hono();
  registerChatRoutes(app, context);
  const post = (body: unknown) => app.request("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { db, context, app, post };
}

const first = { id: "s1", message: { id: "u1", role: "user", parts: [{ type: "text", text: "why?" }] } };

test("a missing model key answers with a plain text 400", async () => {
  const { post } = await setup();
  const res = await post(first);
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await res.text(), /api key not configured/i);
});

test("a busy session answers 409 and makes no model call, title included", async () => {
  const { db, context, post } = await setup();
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.writeHead(500).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await db.insert(providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "test" }) }).run();
    await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-test" });
    context.activeStreams.set("s1", { broadcaster: new StreamBroadcaster(), controller: new AbortController() });
    const res = await post(first);
    assert.equal(res.status, 409);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(await res.text(), /already processing/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 0);
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
});

test("an unexpected failure answers with a plain text 500", async () => {
  const { context, post } = await setup();
  (context as { db: unknown }).db = { select: () => { throw new Error("disk full"); } };
  const res = await post(first);
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await res.text(), "disk full");
});

test("subscribing to a session that is streaming with no run marks it done", async () => {
  const { db, app } = await setup();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(chatSessions).values({ id: "stuck", title: "t", messages: "x", status: "streaming", createdAt: now, updatedAt: now }).run();
  await db.insert(chatSessions).values({ id: "restarted", title: "t", messages: "x", status: "streaming", createdAt: 1, updatedAt: 1 }).run();
  assert.equal((await app.request("/api/chat/subscribe/stuck")).status, 404);
  assert.equal((await app.request("/api/chat/subscribe/restarted")).status, 404);
  const status = async (id: string) => (await db.select().from(chatSessions).where(eq(chatSessions.id, id)).get())?.status;
  assert.equal(await status("stuck"), "done");
  assert.equal(await status("restarted"), "streaming", "a run from before the start is left to the restart resume");
});

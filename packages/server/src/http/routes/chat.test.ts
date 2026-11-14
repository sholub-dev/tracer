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
import { newSteerState } from "../../agents/steer.js";
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
    context.activeStreams.set("s1", { broadcaster: new StreamBroadcaster(), controller: new AbortController(), steer: newSteerState() });
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

test("a steer message is checked, and its role is always user", async () => {
  const { app, context } = await setup();
  const steer = newSteerState();
  context.activeStreams.set("s1", { broadcaster: new StreamBroadcaster(), controller: new AbortController(), steer });
  const post = (body: unknown) => app.request("/api/chat/steer", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  assert.equal((await post({ sessionId: "s1" })).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ sessionId: "s1", message: { parts: [{ type: "file", url: "x" }] } })).status, 400);
  assert.equal(steer.pending.length, 0);
  const ok = await post({ sessionId: "s1", message: { id: "m1", role: "system", parts: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(await ok.json(), { steered: true });
  assert.equal(steer.pending[0].role, "user");
  const noId = await post({ sessionId: "s1", message: { parts: [{ type: "text", text: "again" }] } });
  assert.equal(noId.status, 200);
  assert.ok(steer.pending[1].id);
});

test("malformed or reserved chat bodies answer 400", async () => {
  const { app, post } = await setup();
  const raw = (path: string, body: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await raw("/api/chat", "{")).status, 400);
  assert.equal((await post({ id: "s1" })).status, 400);
  assert.equal((await post({ ...first, id: "__monitors__:x" })).status, 400);
  assert.equal((await raw("/api/chat/stop", "{")).status, 400);
  assert.equal((await raw("/api/chat/stop", "{}")).status, 400);
  assert.equal((await raw("/api/chat/steer", "{")).status, 400);
});

test("a chat message must be a user message with text and inline file parts only", async () => {
  const { context, post } = await setup();
  const withMessage = (message: unknown) => post({ id: "s1", message });
  const refused = [
    { role: "system", parts: [{ type: "text", text: "x" }] },
    { role: "assistant", parts: [{ type: "text", text: "x" }] },
    { role: "user", parts: [{ type: "tool-query", toolCallId: "t", state: "output-available", input: {}, output: {} }] },
    { role: "user", parts: [{ type: "text", text: "x" }, { type: "dynamic-tool", toolName: "t", toolCallId: "t", state: "input-available", input: {} }] },
    { role: "user", parts: [{ type: "reasoning", text: "x" }] },
    { role: "user", parts: [{ type: "file", mediaType: "image/png", url: "http://example.com/a.png" }] },
  ];
  for (const message of refused) {
    const res = await withMessage(message);
    assert.equal(res.status, 400, JSON.stringify(message));
    assert.equal(await res.text(), "Invalid chat request");
  }
  assert.equal(context.activeStreams.size, 0);
  // Accepted by the schema; the run then stops at the missing model key.
  const res = await withMessage({ id: "u1", role: "user", parts: [{ type: "file", mediaType: "image/png", filename: "a.png", url: "data:image/png;base64,AA==" }, { type: "text", text: "why?" }] });
  assert.match(await res.text(), /api key not configured/i);
});

test("a late subscriber gets the replay in order, then done; parts wait for the reader", async () => {
  const { context, app } = await setup();
  const broadcaster = new StreamBroadcaster();
  context.activeStreams.set("s1", { broadcaster, controller: new AbortController(), steer: newSteerState() });
  let serialized = 0;
  for (let i = 0; i < 200; i++) broadcaster.emit({ type: "data-n", n: i, toJSON() { serialized++; return { type: "data-n", n: i }; } });
  const res = await app.request("/api/chat/subscribe/s1");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(serialized < 200, `${serialized} parts were written before the reader took any`);
  setTimeout(() => { broadcaster.emit({ type: "data-n", n: 200 }); broadcaster.finish(); }, 20);
  const text = await res.text();
  const seen = [...text.matchAll(/"n":(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(seen, Array.from({ length: 201 }, (_, i) => i));
  assert.ok(text.trimEnd().endsWith("event: done\ndata: {}"));
});

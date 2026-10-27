import { test } from "node:test";
import assert from "node:assert/strict";
import { McpProvider } from "./mcp-provider.js";
import { CONFIG } from "../config.js";

function providerWithClient(onTools: () => Promise<Record<string, unknown>>) {
  const p = new McpProvider({ label: "X", servers: [] } as never, {}, "x");
  (p as any).clients = [{ tools: onTools, close: async () => {} }];
  return p;
}

test("ping refills the tool cache after invalidateTools, with one shared discovery", async () => {
  let calls = 0;
  const p = providerWithClient(async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { q: {} }; });
  (p as any).cachedTools = { q: {} };
  p.invalidateTools();
  (p as any).clients = [{ tools: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { q: {} }; }, close: async () => {} }];
  assert.equal(p.getCachedTools(), null);
  const [a, b] = await Promise.all([p.ping(), p.ping()]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(p.getCachedTools()!), ["q"]);
});

test("idle close keeps the cached tools and a tool call respawns the clients before it runs", async () => {
  const p = new McpProvider({ label: "X", servers: [] } as never, {}, "x");
  let spawned = 0;
  const client = (tag: string) => ({ tools: async () => ({ q: { execute: async () => tag } }), close: async () => {} });
  (p as any).createClients = async () => { spawned++; (p as any).clients = [client("fresh")]; };
  (p as any).clients = [client("old")];
  await (p as any).discoverTools();
  (p as any).armIdleClose();
  await (p as any).closeAllClients();
  (p as any).idle = true;
  assert.deepEqual(Object.keys(p.getCachedTools()!), ["q"]);
  assert.equal(await p.getCachedTools()!.q.execute(), "fresh");
  assert.equal(spawned, 1);
  clearTimeout((p as any).idleTimer);
});

test("invalidateTools marks the provider not connected so the next chat run reconnects it", () => {
  const p = providerWithClient(async () => ({ q: {} }));
  p.connected = true;
  p.invalidateTools();
  assert.equal(p.connected, false);
});

test("a failed ping closes the clients so the next ping respawns them", async () => {
  const p = new McpProvider({ label: "X", servers: [] } as never, {}, "x");
  let closed = 0;
  let spawned = 0;
  (p as any).clients = [{ tools: async () => { throw new Error("transport closed"); }, close: async () => { closed++; } }];
  (p as any).createClients = async () => { spawned++; (p as any).clients = [{ tools: async () => ({ q: {} }), close: async () => {} }]; };
  assert.equal((await p.ping()).ok, false);
  assert.equal(closed, 1);
  (p as any).lastReconnectAttempt = 0;
  assert.equal((await p.ping()).ok, true);
  assert.equal(spawned, 1);
  clearTimeout((p as any).idleTimer);
});

test("a ping whose respawn fails marks the provider not connected and reports the cause", async () => {
  const p = new McpProvider({ label: "X", servers: [] } as never, {}, "x");
  p.connected = true;
  (p as any).createClients = async () => { throw new Error("spawn npx ENOENT"); };
  const result = await p.ping();
  assert.deepEqual(result, { ok: false, error: "spawn npx ENOENT" });
  assert.equal(p.connected, false);
});

test("a tool call after an idle close fails when tool discovery never answers", async () => {
  const config = CONFIG as { mcpInitTimeoutMs: number };
  const saved = config.mcpInitTimeoutMs;
  config.mcpInitTimeoutMs = 30;
  const p = new McpProvider({ label: "X", servers: [] } as never, {}, "x");
  (p as any).liveTools = { q: { execute: async () => "ok" } };
  (p as any).createClients = async () => { (p as any).clients = [{ tools: () => new Promise(() => {}), close: async () => {} }]; };
  try {
    await assert.rejects(() => (p as any).execute("q", []), /Timeout after .*MCP tool discovery/);
    assert.equal((p as any).clients.length, 0);
  } finally {
    config.mcpInitTimeoutMs = saved;
  }
});

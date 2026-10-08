import { test } from "node:test";
import assert from "node:assert/strict";
import { McpProvider } from "./mcp-provider.js";

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

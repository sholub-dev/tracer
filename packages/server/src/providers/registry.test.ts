import { test } from "node:test";
import assert from "node:assert/strict";
import type { IProvider } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { CONFIG } from "../config.js";
import { ProviderRegistry } from "./registry.js";

function fakeDb(types: string[]): Db {
  const rows = types.map((type) => ({ type, config: "{}" }));
  return { select: () => ({ from: () => ({ all: async () => rows }) }) } as unknown as Db;
}

/** A provider whose first connection check ends only when `connect` is called. */
function slowProvider(type: string) {
  let connect = () => {};
  const provider = {
    name: type,
    type,
    connected: false,
    lastChecked: null,
    initialize: () => new Promise<void>((resolve) => {
      connect = () => { provider.connected = true; resolve(); };
    }),
    ping: async () => ({ ok: provider.connected }),
    dispose: async () => {},
  };
  return { provider: provider as unknown as IProvider, connect: () => connect() };
}

test("a status read during startup waits for every stored provider", async () => {
  const registry = new ProviderRegistry();
  const slow = slowProvider("newrelic");
  const fast = slowProvider("posthog");
  registry.registerFactory("newrelic", () => slow.provider, { label: "New Relic", configFields: [] });
  registry.registerFactory("posthog", () => fast.provider, { label: "PostHog", configFields: [] });

  void registry.initializeFromDb(fakeDb(["newrelic", "posthog"]));
  let loaded = false;
  const read = registry.whenLoaded().then(() => { loaded = true; });

  await new Promise((resolve) => setTimeout(resolve, 10));
  // The checks run in parallel: the second source starts before the first one ends.
  fast.connect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loaded, false);

  slow.connect();
  await read;
  assert.deepEqual(registry.getStatus().map((s) => [s.type, s.connected]), [["newrelic", true], ["posthog", true]]);
});

test("a status read during a reload waits for the new providers", async () => {
  const registry = new ProviderRegistry();
  let current = slowProvider("posthog");
  registry.registerFactory("posthog", () => current.provider, { label: "PostHog", configFields: [] });
  const db = fakeDb(["posthog"]);
  const first = registry.initializeFromDb(db);
  await new Promise((resolve) => setTimeout(resolve, 10));
  current.connect();
  await first;

  current = slowProvider("posthog");
  void registry.reloadFromDb(db);
  const read = registry.whenLoaded();
  await new Promise((resolve) => setTimeout(resolve, 10));
  current.connect();
  await read;
  assert.deepEqual(registry.getStatus().map((s) => [s.type, s.connected]), [["posthog", true]]);
});

test("reconnectDisconnected pings a disconnected provider once per cooldown and survives a failed ping", async () => {
  const registry = new ProviderRegistry();
  let pings = 0;
  const down = { name: "down", type: "down", connected: false, ping: async () => { pings++; throw new Error("boom"); } };
  const up = { name: "up", type: "up", connected: true, ping: async () => { pings += 100; return { ok: true }; } };
  registry.register(down as unknown as IProvider);
  registry.register(up as unknown as IProvider);
  await registry.reconnectDisconnected();
  await registry.reconnectDisconnected();
  assert.equal(pings, 1);
});

test("reconnectDisconnected stops waiting after the limit and the ping still updates the status", async () => {
  const realWait = CONFIG.providerReconnectWaitMs;
  (CONFIG as unknown as { providerReconnectWaitMs: number }).providerReconnectWaitMs = 20;
  try {
    const registry = new ProviderRegistry();
    let finish = () => {};
    const provider = {
      name: "newrelic",
      type: "newrelic",
      connected: false,
      lastChecked: null,
      ping: () => new Promise((resolve) => { finish = () => { provider.connected = true; resolve({ ok: true }); }; }),
      dispose: async () => {},
    };
    registry.register(provider as unknown as IProvider);

    const started = Date.now();
    await registry.reconnectDisconnected();
    assert.ok(Date.now() - started < 1000);
    assert.equal(provider.connected, false);

    finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(provider.connected, true);
  } finally {
    (CONFIG as unknown as { providerReconnectWaitMs: number }).providerReconnectWaitMs = realWait;
  }
});

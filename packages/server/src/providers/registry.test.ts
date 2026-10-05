import { test } from "node:test";
import assert from "node:assert/strict";
import type { IProvider } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
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

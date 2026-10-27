import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { providerConfigs } from "../../db/schema.js";
import { providerRouter } from "./provider.router.js";

test("saveConfig stores values without surrounding whitespace", async () => {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const created: Record<string, string>[] = [];
  const providers = {
    getRegisteredTypes: () => [{ type: "posthog" }],
    unregister: async () => {},
    createFromFactory: (_type: string, config: Record<string, string>) => { created.push(config); return { connected: true, initialize: async () => {} }; },
    register: () => {},
  };
  const api = providerRouter.createCaller({ db, providers } as never);
  await api.saveConfig({ type: "posthog", config: { apiKey: " phx_key\n", projectId: " 123 " } });
  const stored = JSON.parse((await db.select().from(providerConfigs).get())!.config);
  assert.deepEqual(stored, { apiKey: "phx_key", projectId: "123" });
  assert.deepEqual(created[0], stored);
});

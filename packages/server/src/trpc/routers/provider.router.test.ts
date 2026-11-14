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

async function posthogCaller() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const providers = {
    getRegisteredTypes: () => [
      { type: "posthog", configFields: [{ key: "apiKey", type: "password" }, { key: "projectId", type: "text" }, { key: "host", type: "text" }] },
      { type: "plain" },
    ],
    createFromFactory: () => ({ connected: true, initialize: async () => {} }),
    register: () => {},
  };
  const api = providerRouter.createCaller({ db, providers } as never);
  const stored = async (type: string) => JSON.parse((await db.select().from(providerConfigs).all()).find((r) => r.type === type)!.config);
  return { db, api, stored };
}

test("saveConfig refuses a PostHog host that is not https and a project ID that is not a number", async () => {
  const { db, api } = await posthogCaller();
  await assert.rejects(api.saveConfig({ type: "posthog", config: { apiKey: "k", projectId: "1", host: "http://posthog.example" } }), /https/);
  await assert.rejects(api.saveConfig({ type: "posthog", config: { apiKey: "k", projectId: "1", host: "posthog.example" } }), /https/);
  await assert.rejects(api.saveConfig({ type: "posthog", config: { apiKey: "k", projectId: "1/../2" } }), /number/);
  assert.equal((await db.select().from(providerConfigs).all()).length, 0);
  await api.saveConfig({ type: "posthog", config: { apiKey: "k", projectId: "1", host: "https://eu.posthog.com/" } });
  await api.saveConfig({ type: "posthog", config: { apiKey: "k", projectId: "1", host: "" } });
});

test("saveConfig keeps a stored secret when the client sends its masked form", async () => {
  const { api, stored } = await posthogCaller();
  await api.saveConfig({ type: "posthog", config: { apiKey: "phx_secret_1234", projectId: "1" } });
  const shown = (await api.getConfigs()).find((c) => c.type === "posthog")!.config;
  assert.notEqual(shown.apiKey, "phx_secret_1234");
  await api.saveConfig({ type: "posthog", config: { ...shown, projectId: "2" } });
  assert.deepEqual(await stored("posthog"), { apiKey: "phx_secret_1234", projectId: "2" });
  await api.saveConfig({ type: "posthog", config: { ...shown, apiKey: "phx_new_key" } });
  assert.equal((await stored("posthog")).apiKey, "phx_new_key");
});

test("a provider with no declared fields masks and keeps token and password values", async () => {
  const { api, stored } = await posthogCaller();
  const config = { accessToken: "token-value-1", password: "password-value-1", region: "eu" };
  await api.saveConfig({ type: "plain", config });
  const shown = (await api.getConfigs()).find((c) => c.type === "plain")!.config;
  assert.equal(shown.region, "eu");
  assert.ok(!shown.accessToken.includes("token-value") && !shown.password.includes("password-value"));
  await api.saveConfig({ type: "plain", config: { ...shown, region: "us" } });
  assert.deepEqual(await stored("plain"), { ...config, region: "us" });
});

test("listVertexModels makes no request for a stored location that is not a region name", async () => {
  const { db, api } = await posthogCaller();
  await db.insert(providerConfigs).values({ type: "google-vertex", config: JSON.stringify({ projectId: "p", location: "evil.example/x?" }) }).run();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
  try {
    assert.deepEqual(await api.listVertexModels(), []);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});

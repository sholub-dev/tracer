import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { appSettings, providerConfigs } from "../../db/schema.js";
import { settingsRouter } from "./settings.router.js";

async function caller() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return { db, api: settingsRouter.createCaller({ db } as never) };
}

test("step and budget fields reject non-integers and bad Anthropic budgets", async () => {
  const { api } = await caller();
  await assert.rejects(api.saveAgentConfig({ directModeMaxSteps: 10.5 }));
  await assert.rejects(api.saveAgentConfig({ thinkingBudgetGoogle: 1.5 }));
  await assert.rejects(api.saveAgentConfig({ thinkingBudgetAnthropic: 500 }));
  await assert.rejects(api.saveAgentConfig({ timezone: "Not/AZone" }));
  await api.saveAgentConfig({ thinkingBudgetAnthropic: 0 });
  await api.saveAgentConfig({ thinkingBudgetAnthropic: 1024 });
  assert.equal((await api.getAgentConfig()).thinkingBudgetAnthropic, 1024);
});

test("saveAgentConfig writes only changed fields", async () => {
  const { db, api } = await caller();
  const current = await api.getAgentConfig();
  await api.saveAgentConfig({ ...current, directModeMaxSteps: 7 });
  const keys = (await db.select().from(appSettings).all()).map((r) => r.key);
  assert.deepEqual(keys.filter((k) => k !== "device_id"), ["direct_mode_max_steps"]);
});

test("saveVertexConfig accepts only a host-safe location and project", async () => {
  const { db, api } = await caller();
  await api.saveVertexConfig({});
  await api.saveVertexConfig({ projectId: "example.com:my-project", location: "us-central1" });
  assert.deepEqual(await api.getVertexConfig(), { projectId: "example.com:my-project", location: "us-central1" });
  for (const location of ["evil.example/x?", "us-central1.evil.example", "US-CENTRAL1", "a b", ""]) {
    await assert.rejects(api.saveVertexConfig({ location }), /location/i, location);
  }
  for (const projectId of ["p/../x", "p?x", "p#x", "p x"]) {
    await assert.rejects(api.saveVertexConfig({ projectId }), /project/i, projectId);
  }
  assert.deepEqual(await api.getVertexConfig(), { projectId: "example.com:my-project", location: "us-central1" });

  await db.update(providerConfigs).set({ config: JSON.stringify({ projectId: "p", location: "evil.example/x?" }) }).run();
  await assert.rejects(api.saveVertexConfig({ projectId: "other" }), /not valid/);
  await api.saveVertexConfig({ location: "global" });
  assert.deepEqual(await api.getVertexConfig(), { projectId: "p", location: "global" });
});

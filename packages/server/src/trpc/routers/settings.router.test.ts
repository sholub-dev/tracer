import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { appSettings } from "../../db/schema.js";
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
  assert.deepEqual(keys.filter((k) => !["model_reset_0_3_7", "device_id"].includes(k)), ["direct_mode_max_steps"]);
});

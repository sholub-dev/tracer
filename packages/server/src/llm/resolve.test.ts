import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetryableFailures } from "./resolve.js";

const failWith = (err: unknown) => withRetryableFailures((async () => { throw err; }) as typeof fetch)("http://x");

test("a bare WebKit network error becomes a TypeError 'fetch failed' with a cause", async () => {
  const original = new TypeError("Load failed");
  await assert.rejects(failWith(original), (e: Error) => e instanceof TypeError && e.message === "fetch failed" && e.cause === original);
});

test("an abort passes through unchanged; any other rejection becomes retryable", async () => {
  const abort = new DOMException("aborted", "AbortError");
  await assert.rejects(failWith(abort), (e) => e === abort);
  const other = new Error("Software caused connection abort");
  await assert.rejects(failWith(other), (e) => e instanceof TypeError && e.message === "fetch failed" && e.cause === other);
});

test("a successful response passes through", async () => {
  const res = new Response("ok");
  assert.equal(await withRetryableFailures((async () => res) as typeof fetch)("http://x"), res);
});

test("an Anthropic thinking budget below 1024 is raised to 1024; zero turns thinking off", async () => {
  const { createNodeDb } = await import("../db/node-db.js");
  const { runSetup } = await import("../db/setup.js");
  const { writeAppSetting } = await import("../db/config-reader.js");
  const { SETTINGS_KEYS } = await import("../config.js");
  const { db, setupDriver } = createNodeDb(new (await import("better-sqlite3-multiple-ciphers")).default(":memory:"));
  await runSetup(setupDriver);
  await db.insert((await import("../db/schema.js")).providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "k" }) }).run();
  await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-sonnet-4-5" });
  const { resolveModel } = await import("./resolve.js");
  await writeAppSetting(db, SETTINGS_KEYS.thinkingBudgetAnthropic, 500);
  const low = await resolveModel(db);
  assert.equal((low as any).providerOptions.anthropic.thinking.budgetTokens, 1024);
  await writeAppSetting(db, SETTINGS_KEYS.thinkingBudgetAnthropic, 0);
  assert.equal((await resolveModel(db) as any).providerOptions, undefined);
});

test("a Gemini Pro model never gets a thinking budget below its minimum; Flash keeps zero", async () => {
  const { createNodeDb } = await import("../db/node-db.js");
  const { runSetup } = await import("../db/setup.js");
  const { writeAppSetting } = await import("../db/config-reader.js");
  const { SETTINGS_KEYS } = await import("../config.js");
  const { providerConfigs } = await import("../db/schema.js");
  const { db, setupDriver } = createNodeDb(new (await import("better-sqlite3-multiple-ciphers")).default(":memory:"));
  await runSetup(setupDriver);
  await db.insert(providerConfigs).values({ type: "google", config: JSON.stringify({ apiKey: "k" }) }).run();
  const { resolveModel } = await import("./resolve.js");
  await writeAppSetting(db, SETTINGS_KEYS.thinkingBudgetGoogle, 0);
  await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "google", modelId: "gemini-3.1-pro-preview" });
  assert.ok((await resolveModel(db) as any).providerOptions.google.thinkingConfig.thinkingBudget >= 128);
  await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "google", modelId: "gemini-3.7-flash" });
  assert.equal((await resolveModel(db) as any).providerOptions.google.thinkingConfig.thinkingBudget, 0);
});

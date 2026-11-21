import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "./node-db.js";
import { runSetup } from "./setup.js";
import { readAppSetting, readProviderConfig, writeAppSetting, writeProviderConfig } from "./config-reader.js";
import { seedConfigFromEnv } from "./env-config.js";
import { SETTINGS_KEYS } from "../config.js";
import { appSettings } from "./schema.js";
import { eq } from "drizzle-orm";

async function freshDb() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return db;
}

const updatedAt = async (db: Awaited<ReturnType<typeof freshDb>>, key: string) =>
  (await db.select().from(appSettings).where(eq(appSettings.key, key)).get())?.updatedAt;

test("a fresh database gets every mapped target", async () => {
  const db = await freshDb();
  const seeded = await seedConfigFromEnv(db, {
    TRACER_ANTHROPIC_API_KEY: "a", TRACER_GOOGLE_API_KEY: "g",
    TRACER_NEW_RELIC_API_KEY: "n", TRACER_NEW_RELIC_ACCOUNT_ID: "1",
    TRACER_POSTHOG_API_KEY: "p", TRACER_POSTHOG_PROJECT_ID: "2", TRACER_POSTHOG_HOST: "https://eu.posthog.com",
    TRACER_JIRA_DOMAIN: "x.atlassian.net", TRACER_JIRA_EMAIL: "e@x", TRACER_JIRA_API_TOKEN: "t",
    TRACER_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/x",
    TRACER_CHAT_MODEL: "anthropic/claude-haiku-4-5-20251001",
  });
  assert.equal(seeded.length, 7);
  assert.deepEqual(await readProviderConfig(db, "anthropic"), { apiKey: "a" });
  assert.deepEqual(await readProviderConfig(db, "newrelic"), { apiKey: "n", accountId: "1" });
  assert.deepEqual(await readProviderConfig(db, "posthog"), { apiKey: "p", projectId: "2", host: "https://eu.posthog.com" });
  assert.deepEqual(await readAppSetting(db, "integration:jira"), { domain: "x.atlassian.net", email: "e@x", apiToken: "t" });
  assert.deepEqual(await readAppSetting(db, SETTINGS_KEYS.chatModel), { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" });
});

test("a seed keeps stored fields the environment does not supply", async () => {
  const db = await freshDb();
  await writeAppSetting(db, "integration:slack", { webhookUrl: "old", mentions: "@here" });
  await writeProviderConfig(db, "posthog", { apiKey: "old", projectId: "2", host: "ui-host" });
  await seedConfigFromEnv(db, { TRACER_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/new", TRACER_POSTHOG_API_KEY: "new" });
  assert.deepEqual(await readAppSetting(db, "integration:slack"), { webhookUrl: "https://hooks.slack.com/services/new", mentions: "@here" });
  assert.deepEqual(await readProviderConfig(db, "posthog"), { apiKey: "new", projectId: "2", host: "ui-host" });
});

test("an unchanged value causes no write", async () => {
  const db = await freshDb();
  const env = { TRACER_SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/u", TRACER_CHAT_MODEL: "google/m" };
  await seedConfigFromEnv(db, { ...env });
  await db.update(appSettings).set({ updatedAt: 1 }).run();
  assert.deepEqual(await seedConfigFromEnv(db, { ...env }), []);
  assert.equal(await updatedAt(db, "integration:slack"), 1);
  assert.equal(await updatedAt(db, SETTINGS_KEYS.chatModel), 1);
});

test("TRACER_CHAT_MODEL keeps a model chosen in the UI", async () => {
  const db = await freshDb();
  await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "google", modelId: "gemini-3.7-flash" });
  assert.deepEqual(await seedConfigFromEnv(db, { TRACER_CHAT_MODEL: "anthropic/claude-haiku-4-5-20251001" }), []);
  assert.deepEqual(await readAppSetting(db, SETTINGS_KEYS.chatModel), { provider: "google", modelId: "gemini-3.7-flash" });
});

test("unset or empty variables leave targets untouched", async () => {
  const db = await freshDb();
  await writeProviderConfig(db, "anthropic", { apiKey: "keep" });
  assert.deepEqual(await seedConfigFromEnv(db, { TRACER_ANTHROPIC_API_KEY: "", TRACER_NEW_RELIC_ACCOUNT_ID: undefined }), []);
  assert.deepEqual(await readProviderConfig(db, "anthropic"), { apiKey: "keep" });
  assert.equal(await readProviderConfig(db, "newrelic"), null);
});

test("a malformed TRACER_CHAT_MODEL is skipped", async () => {
  const db = await freshDb();
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const bad of ["nomodel", "anthropic/", "/model"]) {
      assert.deepEqual(await seedConfigFromEnv(db, { TRACER_CHAT_MODEL: bad }), []);
    }
  } finally {
    console.warn = warn;
  }
  assert.equal(await readAppSetting(db, SETTINGS_KEYS.chatModel), null);
});

test("values that fail the settings checks are ignored", async () => {
  const db = await freshDb();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await seedConfigFromEnv(db, {
      TRACER_POSTHOG_API_KEY: "p", TRACER_POSTHOG_HOST: "http://169.254.169.254", TRACER_POSTHOG_PROJECT_ID: "x",
      TRACER_JIRA_DOMAIN: "evil.example/x", TRACER_SLACK_WEBHOOK_URL: "https://example.com/hook",
    }), ["posthog"]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await readProviderConfig(db, "posthog"), { apiKey: "p" });
  assert.equal(await readAppSetting(db, "integration:jira"), null);
  assert.equal(await readAppSetting(db, "integration:slack"), null);
});

test("a seed removes the variables it read", async () => {
  const db = await freshDb();
  const env: Record<string, string | undefined> = { TRACER_ANTHROPIC_API_KEY: "a", TRACER_CHAT_MODEL: "google/m", TRACER_PORT: "1" };
  await seedConfigFromEnv(db, env);
  assert.deepEqual(env, { TRACER_PORT: "1" });
});

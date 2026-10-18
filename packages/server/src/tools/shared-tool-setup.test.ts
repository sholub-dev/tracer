import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { Db } from "../db/driver.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { writeAppSetting } from "../db/config-reader.js";
import { writeJiraConfig } from "../integrations/jira/config.js";
import { DEFAULTS, SETTINGS_KEYS } from "../config.js";
import { writeSlackConfig } from "../integrations/slack.js";
import { collectBaseTools } from "./shared-tool-setup.js";

function memoryDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tool_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, note TEXT NOT NULL, review_note TEXT, source_session_id TEXT, source TEXT NOT NULL DEFAULT 'agent', last_used_at INTEGER, uid TEXT, created_at INTEGER NOT NULL DEFAULT 0);
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

function fakeRegistry(providers: object[]): ProviderRegistry {
  return { whenLoaded: async () => {}, reconnectDisconnected: async () => {}, getAllProviders: () => providers } as unknown as ProviderRegistry;
}

const provider = {
  type: "newrelic", name: "New Relic", connected: true,
  getChatTools: () => ({
    tools: { execute_nrql: {} },
    maxSteps: 7,
    promptFragments: ["# New Relic"],
    systemPrompt: "Direct prompt. You have a maximum of 100 steps, covering all.",
  }),
};
const JIRA = { domain: "example", email: "a@b.c", apiToken: "t" };

test("the Steps per answer setting is the step limit and the number in the prompt", async () => {
  const db = memoryDb();
  await writeAppSetting(db, SETTINGS_KEYS.directModeMaxSteps, 12);
  const unified = await collectBaseTools(fakeRegistry([provider]), db, undefined, "unified");
  assert.equal(unified.maxSteps, 12);
  assert.match(unified.systemPrompt!, /maximum of 12 steps/);
  const direct = await collectBaseTools(fakeRegistry([provider]), db, undefined, "direct");
  assert.equal(direct.maxSteps, 12);
  assert.match(direct.systemPrompt!, /maximum of 12 steps/);
});

test("the step limit falls back to the default when the setting is unset", async () => {
  const setup = await collectBaseTools(fakeRegistry([provider]), memoryDb(), undefined, "unified");
  assert.equal(setup.maxSteps, DEFAULTS.directModeMaxSteps);
  assert.match(setup.systemPrompt!, new RegExp(`maximum of ${DEFAULTS.directModeMaxSteps} steps`));
});

test("with only Jira connected the prompt is the no-provider prompt plus the Jira fragment", async () => {
  const db = memoryDb();
  await writeJiraConfig(db, JIRA);
  for (const mode of ["unified", "direct"] as const) {
    const setup = await collectBaseTools(fakeRegistry([]), db, undefined, mode, undefined, true);
    assert.ok("get_jira_issue" in setup.tools);
    assert.match(setup.systemPrompt!, /No observability providers are currently configured/);
    assert.match(setup.systemPrompt!, /## Jira/);
    assert.doesNotMatch(setup.systemPrompt!, /Root-Cause Discipline|Response Format/);
  }
});

test("with a provider tool the unified prompt is the full prompt and includes Jira", async () => {
  const db = memoryDb();
  await writeJiraConfig(db, JIRA);
  const setup = await collectBaseTools(fakeRegistry([provider]), db, undefined, "unified", undefined, true);
  assert.match(setup.systemPrompt!, /Response Format/);
  assert.match(setup.systemPrompt!, /## Jira/);
  assert.deepEqual(setup.providerTypes, ["newrelic"]);
});

test("Slack adds post_slack_message and its prompt fragment to chat, and not to the builder", async () => {
  const db = memoryDb();
  await writeSlackConfig(db, { webhookUrl: "https://hooks.slack.com/services/T/B/x" });
  for (const mode of ["unified", "direct"] as const) {
    const setup = await collectBaseTools(fakeRegistry([provider]), db, undefined, mode, undefined, true);
    assert.ok("post_slack_message" in setup.tools);
    assert.match(setup.systemPrompt!, /post_slack_message/);
  }
  const none = await collectBaseTools(fakeRegistry([]), db, undefined, "unified", undefined, true);
  assert.match(none.systemPrompt!, /No observability providers[\s\S]*## Slack/);
  assert.equal("post_slack_message" in (await collectBaseTools(fakeRegistry([provider]), db, undefined, "unified")).tools, false);
  assert.equal("post_slack_message" in (await collectBaseTools(fakeRegistry([provider]), memoryDb(), undefined, "unified", undefined, true)).tools, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { Db } from "../db/driver.js";
import { writeSlackConfig } from "../integrations/slack.js";
import { postSlackMessageTool } from "./slack-tool.js";

async function run(text: string): Promise<unknown> {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);");
  const db = drizzle(sqlite, { schema }) as unknown as Db;
  await writeSlackConfig(db, { webhookUrl: "https://hooks.slack.com/services/T0/B0/x" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
  try {
    const exec = postSlackMessageTool(db).execute as (a: { text: string }, o: object) => Promise<unknown>;
    return await exec({ text }, {});
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a plain post reports only posted", async () => {
  assert.deepEqual(await run("Errors are down since 10:00."), { posted: true });
});

test("a post with a link says the link was removed", async () => {
  const out = (await run("See https://example.com/a/b for details.")) as { posted: true; redacted?: string };
  assert.equal(out.posted, true);
  assert.match(out.redacted ?? "", /removed/);
});

test("a long post says it was cut", async () => {
  const out = (await run("word ".repeat(1000))) as { posted: true; clipped?: string };
  assert.match(out.clipped ?? "", /2900/);
});

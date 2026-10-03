import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { eq } from "drizzle-orm";
import { createNodeDb } from "./node-db.js";
import { runInTransaction } from "./driver.js";
import { runSetup } from "./setup.js";
import { appSettings, providerConfigs } from "./schema.js";

async function setup() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return db;
}

const keys = async (db: Awaited<ReturnType<typeof setup>>) =>
  (await db.select({ key: appSettings.key }).from(appSettings).all()).map((r) => r.key);

test("node db: insert, select, update, delete, RETURNING", async () => {
  const db = await setup();
  await db.insert(appSettings).values({ key: "a", value: "1" }).run();
  await db.update(appSettings).set({ value: "2" }).where(eq(appSettings.key, "a")).run();
  assert.deepEqual(await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "a")).get(), { key: "a", value: "2" });
  assert.deepEqual(await db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, "a")).values(), [["2"]]);
  await db.delete(appSettings).where(eq(appSettings.key, "a")).run();
  assert.equal(await db.select().from(appSettings).where(eq(appSettings.key, "a")).get(), undefined);

  const row = await db.insert(providerConfigs).values({ type: "posthog", config: "{}" }).returning().get();
  assert.equal(row?.type, "posthog");
  assert.equal(typeof row?.id, "number");
});

test("node db: a statement issued during an open transaction waits and is not rolled back with it", async () => {
  const db = await setup();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });

  const tx = runInTransaction(db, async (t) => {
    await t.insert(appSettings).values({ key: "inside", value: "1" }).run();
    await paused;
    throw new Error("rollback");
  });
  const outside = db.insert(appSettings).values({ key: "outside", value: "1" }).run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();

  await assert.rejects(tx, /rollback/);
  await outside;
  const result = await keys(db);
  assert.ok(result.includes("outside"));
  assert.ok(!result.includes("inside"));
});

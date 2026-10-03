import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { eq } from "drizzle-orm";
import { createCapacitorDb, type CapacitorConnection } from "./capacitor-client.js";
import { runInTransaction } from "./driver.js";
import { runSetup } from "./setup.js";
import { appSettings, providerConfigs } from "./schema.js";

/** Mimics the plugin: async calls, rows as objects, and an implicit BEGIN unless `transaction` is false. */
function fakeConnection(log: string[]): CapacitorConnection {
  const sqlite = new Database(":memory:");
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    async run(statement, values = [], transaction = true) {
      assert.equal(transaction, false, "run must not open its own transaction");
      await tick();
      log.push(`${statement} ${JSON.stringify(values)}`);
      const r = sqlite.prepare(statement).run(...values);
      return { changes: { changes: r.changes, lastId: Number(r.lastInsertRowid) } };
    },
    async query(statement, values = []) {
      await tick();
      log.push(statement);
      return { values: sqlite.prepare(statement).all(...values) as Record<string, unknown>[] };
    },
    async execute(statements, transaction = true) {
      assert.equal(transaction, false, "execute must not open its own transaction");
      await tick();
      sqlite.exec(statements);
      return {};
    },
  };
}

async function setup() {
  const log: string[] = [];
  const { db, setupDriver } = createCapacitorDb(fakeConnection(log));
  await runSetup(setupDriver);
  log.length = 0;
  return { db, log };
}

test("capacitor db: insert, select, update, delete", async () => {
  const { db } = await setup();
  const inserted = await db.insert(appSettings).values({ key: "a", value: "1" }).run();
  assert.equal((inserted as { changes?: number }).changes, 1);
  assert.deepEqual(await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "a")).get(), { key: "a", value: "1" });

  await db.update(appSettings).set({ value: "2" }).where(eq(appSettings.key, "a")).run();
  assert.equal((await db.select().from(appSettings).where(eq(appSettings.key, "a")).get())?.value, "2");
  assert.deepEqual(await db.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, "a")).values(), [["2"]]);

  await db.delete(appSettings).where(eq(appSettings.key, "a")).run();
  assert.equal(await db.select().from(appSettings).where(eq(appSettings.key, "a")).get(), undefined);
});

test("capacitor db: INSERT ... RETURNING", async () => {
  const { db } = await setup();
  const row = await db.insert(providerConfigs).values({ type: "posthog", config: "{}" }).returning().get();
  assert.equal(row?.type, "posthog");
  assert.equal(typeof row?.id, "number");
});

test("capacitor db: a transaction commits, and rolls back when it throws", async () => {
  const { db } = await setup();
  await runInTransaction(db, async (tx) => {
    await tx.insert(appSettings).values({ key: "kept", value: "1" }).run();
  });
  await assert.rejects(runInTransaction(db, async (tx) => {
    await tx.insert(appSettings).values({ key: "dropped", value: "1" }).run();
    throw new Error("boom");
  }), /boom/);
  const keys = (await db.select({ key: appSettings.key }).from(appSettings).all()).map((r) => r.key);
  assert.ok(keys.includes("kept"));
  assert.ok(!keys.includes("dropped"));
});

test("capacitor db: a statement issued during an open transaction waits for it to end", async () => {
  const { db, log } = await setup();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });

  const tx = runInTransaction(db, async (t) => {
    await t.insert(appSettings).values({ key: "inside", value: "1" }).run();
    await paused;
    throw new Error("rollback");
  });
  const outside = db.insert(appSettings).values({ key: "outside", value: "1" }).run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!log.some((s) => s.includes('"outside"')), "outside write ran while the transaction was open");
  release();

  await assert.rejects(tx, /rollback/);
  await outside;
  const order = ["BEGIN", '"inside"', "ROLLBACK", '"outside"'].map((m) => log.findIndex((s) => s.includes(m)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i >= 0));
  const keys = (await db.select({ key: appSettings.key }).from(appSettings).all()).map((r) => r.key);
  assert.ok(keys.includes("outside"));
  assert.ok(!keys.includes("inside"));
});

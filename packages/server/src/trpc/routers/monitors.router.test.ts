import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { unixNow } from "@tracer-sh/shared";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { monitors, monitorTriggers } from "../../db/schema.js";
import { monitorsRouter } from "./monitors.router.js";

async function caller() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return { db, api: monitorsRouter.createCaller({ db, activeStreams: new Map() } as never) };
}

const monitor = (id: string, createdAt: number) => ({ id, name: id, query: "SELECT count(*) FROM Transaction", condition: "{}", createdAt });

test("the list returns monitors oldest first until the user sets an order", async () => {
  const { db, api } = await caller();
  await db.insert(monitors).values([monitor("b", 2), monitor("a", 1), monitor("c", 3)]).run();
  assert.deepEqual((await api.list()).map((m) => m.id), ["a", "b", "c"]);
});

test("reorder changes the list order and puts new monitors last", async () => {
  const { db, api } = await caller();
  await db.insert(monitors).values([monitor("a", 1), monitor("b", 2), monitor("c", 3)]).run();
  await api.reorder({ ids: ["c", "a"] });
  assert.deepEqual((await api.list()).map((m) => m.id), ["c", "a", "b"]);
});

test("toggleEnabled and setAlertEnabled update the flags", async () => {
  const { db, api } = await caller();
  await db.insert(monitors).values(monitor("a", 1)).run();
  await api.toggleEnabled({ id: "a", enabled: false });
  await api.setAlertEnabled({ id: "a", enabled: false });
  let row = (await api.list())[0];
  assert.equal(row.enabled, 0);
  assert.equal(row.alertEnabled, 0);
  await api.toggleEnabled({ id: "a", enabled: true });
  await api.setAlertEnabled({ id: "a", enabled: true });
  row = (await api.list())[0];
  assert.equal(row.enabled, 1);
  assert.equal(row.alertEnabled, 1);
});

test("toggling a missing monitor throws", async () => {
  const { api } = await caller();
  await assert.rejects(api.toggleEnabled({ id: "nope", enabled: false }), /not found/i);
  await assert.rejects(api.setAlertEnabled({ id: "nope", enabled: false }), /not found/i);
});

test("setCardWidth stores the width and rejects other values", async () => {
  const { db, api } = await caller();
  await db.insert(monitors).values(monitor("a", 1)).run();
  await api.setCardWidth({ id: "a", width: 75 });
  assert.equal((await api.list())[0].cardWidth, 75);
  await assert.rejects(api.setCardWidth({ id: "a", width: 60 } as never));
});

test("delete removes the monitor and its triggers", async () => {
  const { db, api } = await caller();
  await db.insert(monitors).values([monitor("a", 1), monitor("b", 2)]).run();
  const trigger = (id: string, monitorId: string) => ({ id, monitorId, triggeredAt: unixNow(), value: 1, windowStart: 0, windowEnd: 1, status: "investigating", groups: "[]" });
  await db.insert(monitorTriggers).values([trigger("t1", "a"), trigger("t2", "b")]).run();
  await api.delete({ id: "a" });
  assert.deepEqual((await api.list()).map((m) => m.id), ["b"]);
  assert.deepEqual((await db.select().from(monitorTriggers).all()).map((t) => t.id), ["t2"]);
  await assert.rejects(api.delete({ id: "a" }), /not found/i);
});

test("delete refuses while a session of the monitor runs", async () => {
  const { db } = await caller();
  await db.insert(monitors).values(monitor("a", 1)).run();
  await db.insert(monitorTriggers).values({ id: "t", monitorId: "a", triggeredAt: unixNow(), value: 1, windowStart: 0, windowEnd: 1, status: "investigating", groups: "[]", sessionId: "s" }).run();
  const api = monitorsRouter.createCaller({ db, activeStreams: new Map([["s", {}]]) } as never);
  await assert.rejects(api.delete({ id: "a" }), /still running/i);
  assert.equal((await db.select().from(monitors).all()).length, 1);
});

test("triggers returns the monitor's recent triggers, newest first", async () => {
  const { db, api } = await caller();
  await db.insert(monitors).values([monitor("a", 1), monitor("b", 2)]).run();
  const now = unixNow();
  const trigger = (id: string, monitorId: string, triggeredAt: number) => ({ id, monitorId, triggeredAt, value: 1, windowStart: 0, windowEnd: 1, status: "investigating", groups: "[]" });
  await db.insert(monitorTriggers).values([
    trigger("old", "a", now - 1000), trigger("new", "a", now - 10), trigger("other", "b", now - 10), trigger("ancient", "a", now - 100000),
  ]).run();
  const rows = await api.triggers({ monitorId: "a", sinceSeconds: 3600 });
  assert.deepEqual(rows.map((t) => t.id), ["new", "old"]);
  assert.deepEqual(rows[0].groups, []);
});

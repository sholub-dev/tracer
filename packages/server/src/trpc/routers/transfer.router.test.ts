import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../../db/node-db.js";
import { runSetup } from "../../db/setup.js";
import { appSettings } from "../../db/schema.js";
import { transferRouter } from "./transfer.router.js";

async function caller() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return { db, api: transferRouter.createCaller({ db, activeStreams: new Map() } as never) };
}

test("both statuses are null when no sync runs", async () => {
  const { api } = await caller();
  assert.equal(await api.sendStatus(), null);
  assert.equal(await api.receiveStatus(), null);
});

test("approve and deny reject when no request waits", async () => {
  const { api } = await caller();
  await assert.rejects(api.approve(), /There is no request/);
  await assert.rejects(api.deny(), /There is no request/);
});

test("cancelling when idle does nothing", async () => {
  const { api } = await caller();
  await api.cancelSend();
  await api.cancelReceive();
  assert.equal(await api.sendStatus(), null);
  assert.equal(await api.receiveStatus(), null);
});

test("lastSync is null on an empty database and reports the stored peer", async () => {
  const { db, api } = await caller();
  assert.equal(await api.lastSync(), null);
  await db.insert(appSettings).values([{ key: "sync_last_at", value: "1700000000000" }, { key: "sync_peer_name", value: "Phone" }]).run();
  assert.deepEqual(await api.lastSync(), { name: "Phone", at: 1700000000000 });
});

test("receive refuses while an investigation runs", async () => {
  const { db } = await caller();
  const api = transferRouter.createCaller({ db, activeStreams: new Map([["s", {}]]) } as never);
  await assert.rejects(api.receive({ link: "tracer://copy" }), /investigation is running/);
});

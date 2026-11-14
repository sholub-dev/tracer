import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { ProviderRegistry } from "../providers/registry.js";
import { createApp } from "./app.js";

test("a tRPC batch larger than the limit is refused", async () => {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const app = createApp({ db, providers: new ProviderRegistry(), activeStreams: new Map() });
  const batch = (calls: number) => app.request(`/api/trpc/${Array(calls).fill("settings.getAlertTriage").join(",")}?batch=1`);
  assert.equal((await batch(50)).status, 200);
  const res = await batch(51);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /exceeds maximum size/);
});

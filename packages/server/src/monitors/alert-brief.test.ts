import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { encodeMessages } from "../lib/messages-codec.js";
import { alertBrief } from "./repeats.js";

const report = { type: "tool-report_alert_summary", toolCallId: "r", state: "output-available", output: {}, input: { severity: "high", policy: "p", started: "s", status: "open", issues: [] } };
const card = (input: unknown) => ({ type: "tool-report_finding", toolCallId: "f", state: "output-available", output: {}, input });
const dismiss = { type: "tool-dismiss_alert", toolCallId: "d", state: "output-available", output: {}, input: { reason: "already closed" } };

async function env(...parts: unknown[]) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  await db.insert(monitors).values({ id: "m1", name: "Checkout errors", provider: "newrelic", query: "q", condition: "> 0", frequencySeconds: 300 }).run();
  await db.insert(chatSessions).values({ id: "s1", title: "t", messages: encodeMessages([{ id: "", role: "assistant", parts: parts as never }]), status: "done", kind: "monitor", createdAt: 1, updatedAt: 1 }).run();
  await db.insert(monitorTriggers).values({ id: "t1", monitorId: "m1", triggeredAt: 1000, value: 2, windowStart: 0, windowEnd: 0, status: "investigating", groups: "[]", sessionId: "s1" }).run();
  return db;
}

test("alertBrief reads severity, verdict and a markdown-free headline before the outcome is stored", async () => {
  const db = await env(card({ kind: "root_cause", verdict: "problem", headline: "Pool of `db` is **exhausted**." }), report);
  assert.deepEqual(await alertBrief(db, "s1"), {
    name: "Checkout errors", triggeredAt: 1000, severity: "high", verdict: "problem", headline: "Pool of db is exhausted.", dismissed: false,
  });
});

test("alertBrief returns unknown severity and an empty headline without a report", async () => {
  const db = await env();
  assert.deepEqual(await alertBrief(db, "s1"), {
    name: "Checkout errors", triggeredAt: 1000, severity: "unknown", verdict: "", headline: "", dismissed: false,
  });
});

test("alertBrief marks a dismissed alert and returns null for a session without a firing", async () => {
  const db = await env(dismiss);
  assert.equal((await alertBrief(db, "s1"))?.dismissed, true);
  assert.equal(await alertBrief(db, "other"), null);
});

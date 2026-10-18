import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { monitors, monitorTriggers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import type { Context } from "../trpc/context.js";
import type { StartSessionOptions } from "../agents/start-session.js";
import { NewRelicProvider } from "../providers/newrelic/newrelic.provider.js";
import { pendingFiringChanges } from "../lib/firing-events.js";
import { runDueMonitors, resolveFiring, settlePendingFirings, pendingFirings } from "./scheduler.js";

const COUNTDOWN_MS = CONFIG.monitorFiringConfirmSeconds * 1000;
const WINDOW_MS = 300_000;

before(() => {
  const midWindow = (Math.floor(Date.now() / WINDOW_MS) * 300 + 60 + 150) * 1000;
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: midWindow });
});
after(() => mock.timers.reset());

const QUERY = "SELECT count(*) FROM Transaction FACET name SINCE {{SINCE}} UNTIL {{UNTIL}}";
const now = () => Math.floor(Date.now() / 1000);
const settled = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
const nextWindow = () => { mock.timers.tick(WINDOW_MS); };

async function env() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  await db.insert(monitors).values({ id: "m1", name: "M", provider: "newrelic", query: QUERY, condition: "> 0", frequencySeconds: 300 }).run();
  const provider = new NewRelicProvider({ type: "newrelic", apiKey: "x", accountId: "1" });
  provider.connected = true;
  let rows: unknown[] = [{ facet: "api", count: 2 }];
  provider.executeRawQuery = async () => rows;
  const providers = { whenLoaded: async () => {}, reconnectDisconnected: async () => {}, getProvider: () => provider, getAllProviders: () => [provider] };
  const context = { db, providers, activeStreams: new Map() } as unknown as Context;
  const started: StartSessionOptions[] = [];
  const start = async (_c: Context, options: StartSessionOptions) => { started.push(options); return { ok: true as const }; };
  return {
    db, context, started, start,
    run: () => runDueMonitors(context, start),
    setRows: (next: unknown[]) => { rows = next; },
    triggers: () => db.select().from(monitorTriggers).all(),
  };
}

test("a firing waits for the countdown, then starts its session", async () => {
  const { run, started, triggers, db } = await env();
  await run();
  assert.equal(started.length, 0);
  const [pending] = await triggers();
  assert.equal(pending.status, "pending");
  assert.equal(pending.sessionId, null);
  assert.equal((await db.select().from(monitors).get())!.lastStatus, "triggered");

  mock.timers.tick(COUNTDOWN_MS);
  await settled();
  assert.equal(started.length, 1);
  const [after] = await triggers();
  assert.equal(after.status, "investigating");
  assert.equal(after.sessionId, started[0].sessionId);
  assert.ok(parseGroups(after.groups).every((g) => g.sessionId === started[0].sessionId));
});

const parseGroups = (json: string) => JSON.parse(json) as { sessionId: string | null }[];

test("the pending list holds the remaining time, and a change event follows each decision", async () => {
  const { run, context } = await env();
  await run();
  const [item] = await pendingFirings(context.db);
  assert.equal(item.monitorName, "M");
  assert.match(item.detail, /2/);
  assert.ok(item.remainingMs > COUNTDOWN_MS - 2000 && item.remainingMs <= COUNTDOWN_MS);

  const events = pendingFiringChanges();
  await events.next();
  const next = events.next();
  await resolveFiring(context, item.id, "skip");
  await next;
  assert.deepEqual(await pendingFirings(context.db), []);
  await events.return(undefined);
});

test("Yes starts the session at once and a later decision does nothing", async () => {
  const { run, context, start, started, triggers } = await env();
  await run();
  const [pending] = await triggers();
  const result = await resolveFiring(context, pending.id, "start", start);
  assert.equal(started.length, 1);
  assert.equal(result.sessionId, started[0].sessionId);

  assert.deepEqual(await resolveFiring(context, pending.id, "skip", start), { sessionId: null });
  assert.deepEqual(await resolveFiring(context, pending.id, "start", start), { sessionId: null });
  mock.timers.tick(COUNTDOWN_MS);
  await settled();
  assert.equal(started.length, 1);
  assert.equal((await triggers())[0].status, "investigating");
});

test("No skips the firing: no session, and the deadline does not start one", async () => {
  const { run, context, start, started, triggers } = await env();
  await run();
  const [pending] = await triggers();
  assert.deepEqual(await resolveFiring(context, pending.id, "skip", start), { sessionId: null });
  mock.timers.tick(COUNTDOWN_MS);
  await settled();
  assert.equal(started.length, 0);
  const [skipped] = await triggers();
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.sessionId, null);
});

test("two decisions at once give one outcome", async () => {
  const { run, context, start, started, triggers } = await env();
  await run();
  const [pending] = await triggers();
  await Promise.all([resolveFiring(context, pending.id, "start", start), resolveFiring(context, pending.id, "skip", start), resolveFiring(context, pending.id, "start", start)]);
  assert.ok(started.length <= 1);
  assert.equal((await triggers())[0].status, started.length === 1 ? "investigating" : "skipped");
});

test("a firing that outlived a restart starts after its deadline and not before", async () => {
  const { db, context, start, started } = await env();
  const deviceId = (await db.query.appSettings.findFirst({ where: (t, { eq: is }) => is(t.key, "device_id") }))?.value ?? null;
  const row = (id: string, triggeredAt: number) => ({
    id, monitorId: "m1", triggeredAt, value: 2, windowStart: 0, windowEnd: 1, status: "pending", groups: JSON.stringify([{ key: "api", count: 2, sessionId: null, repeat: false }]), sessionId: null, deviceId,
  });
  await db.insert(monitorTriggers).values([row("due", now() - CONFIG.monitorFiringConfirmSeconds), row("fresh", now() - 1)]).run();
  await settlePendingFirings(context, start);
  assert.equal(started.length, 1);
  const rows = await db.select().from(monitorTriggers).all();
  assert.equal(rows.find((r) => r.id === "due")!.status, "investigating");
  assert.equal(rows.find((r) => r.id === "fresh")!.status, "pending");
});

test("crossings after a No are skipped silently until a window is back to normal", async () => {
  const { run, context, start, started, triggers, setRows } = await env();
  await run();
  await resolveFiring(context, (await triggers())[0].id, "skip", start);

  nextWindow();
  await run();
  nextWindow();
  await run();
  const afterNo = await triggers();
  assert.deepEqual(afterNo.map((t) => t.status).sort(), ["skipped", "skipped", "skipped"]);
  assert.equal((await pendingFirings(context.db)).length, 0);

  nextWindow();
  setRows([]);
  await run();
  nextWindow();
  setRows([{ facet: "api", count: 3 }]);
  await run();
  const pending = (await triggers()).filter((t) => t.status === "pending");
  assert.equal(pending.length, 1, "the next crossing asks again");
  mock.timers.tick(COUNTDOWN_MS);
  await settled();
  assert.equal(started.length, 1);
});

test("a new group in a skipped chain asks again", async () => {
  const { run, context, start, triggers, setRows } = await env();
  await run();
  await resolveFiring(context, (await triggers())[0].id, "skip", start);
  nextWindow();
  setRows([{ facet: "api", count: 2 }, { facet: "db", count: 2 }]);
  await run();
  assert.equal((await triggers()).filter((t) => t.status === "pending").length, 1);
});

test("a crossing while an earlier one still waits is muted, not asked twice", async () => {
  const { run, db, triggers, started } = await env();
  await run();
  await db.update(monitors).set({ lastCheckedAt: null }).run();
  await run();
  const statuses = (await triggers()).map((t) => t.status).sort();
  assert.deepEqual(statuses, ["muted", "pending"]);
  mock.timers.tick(COUNTDOWN_MS);
  await settled();
  assert.equal(started.length, 1);
});

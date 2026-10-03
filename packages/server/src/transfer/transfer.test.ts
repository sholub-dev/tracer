import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { appSettings, chatSessions, monitors, monitorTriggers, providerConfigs } from "../db/schema.js";
import { randomSecret, seal, unseal } from "./crypto.js";
import { exportSnapshot, importSnapshot } from "./snapshot.js";
import { inspectCopy, parseCopyLink, receiveCopy } from "./receive.js";
import { approve, deny, sendStatus, startSend, stopSend } from "./send.js";
import { getSetting } from "./peer.js";
import { eq } from "drizzle-orm";

async function freshDb() {
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  return db;
}

async function seededDb() {
  const db = await freshDb();
  await db.insert(providerConfigs).values({ type: "newrelic", config: JSON.stringify({ apiKey: "NRAK-1" }) }).run();
  await db.insert(appSettings).values({ key: "chat_model", value: "claude" }).run();
  await db.insert(chatSessions).values({ id: "s1", title: "Checkout errors", messages: "[]", status: "done" }).run();
  await db.insert(monitors).values({ id: "m1", name: "Error rate", query: "SELECT 1", condition: "{}" }).run();
  await db.insert(monitorTriggers).values({ id: "t1", monitorId: "m1", triggeredAt: 1, value: 4.2, windowStart: 1, windowEnd: 2, status: "investigating", groups: "[]", sessionId: "s1" }).run();
  return db;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check());
}

/** Runs the phone side and allows the request on the computer as soon as it arrives. */
async function receiveWithApproval(phone: Awaited<ReturnType<typeof freshDb>>, link: string) {
  const done = receiveCopy(phone, link);
  done.catch(() => {});
  await until(() => sendStatus().state === "approval");
  approve();
  return done;
}

const setting = (db: Awaited<ReturnType<typeof freshDb>>, key: string) => getSetting(db, key);
const post = (link: string, suffix: string, body: string) => {
  const from = new URL(new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("from")!);
  return fetch(new URL(from.pathname + suffix, from), { method: "POST", body });
};
const keyOf = (link: string) => new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("key")!;

test("seal and unseal round-trip; a wrong key fails", async () => {
  const key = randomSecret();
  const sealed = await seal("hello", key);
  assert.equal(await unseal(sealed, key), "hello");
  await assert.rejects(unseal(sealed, randomSecret()));
});

test("importSnapshot replaces every row with the snapshot rows", async () => {
  const source = await seededDb();
  const target = await freshDb();
  await target.insert(appSettings).values({ key: "only_on_phone", value: "x" }).run();

  const counts = await importSnapshot(target, JSON.parse(JSON.stringify(await exportSnapshot(source))));
  assert.equal(counts.monitors, 1);
  assert.deepEqual(await exportSnapshot(target), await exportSnapshot(source));
});

test("parseCopyLink accepts only local-network http addresses", () => {
  const ok = parseCopyLink(`tracer://copy?from=${encodeURIComponent("http://192.168.1.5:5000/abc")}&key=k`);
  assert.equal(ok.from.host, "192.168.1.5:5000");
  for (const from of ["https://192.168.1.5/abc", "http://example.com/abc", "http://8.8.8.8/abc"]) {
    assert.throws(() => parseCopyLink(`tracer://copy?from=${encodeURIComponent(from)}&key=k`));
  }
  assert.throws(() => parseCopyLink("https://tracer.sh"));
});

test("send serves one copy, once; receive imports it", async (t) => {
  t.after(stopSend);
  const source = await seededDb();
  const target = await freshDb();
  const { link, qrSvg } = await startSend(source, () => 0);
  assert.match(qrSvg, /^<svg/);
  assert.equal(sendStatus().state, "waiting");

  await receiveWithApproval(target, link);
  assert.equal(sendStatus().state, "sent");
  assert.equal((await exportSnapshot(target)).tables.chat_sessions.length, 1);
  await assert.rejects(receiveCopy(target, link), /does not answer|used or expired/);
});

test("receiveCopy pauses the imported monitors; the source stays active", async (t) => {
  t.after(stopSend);
  const source = await seededDb();
  const target = await freshDb();
  const { link } = await startSend(source, () => 0);
  await receiveWithApproval(target, link);
  assert.equal((await target.select().from(monitors).all())[0].enabled, 0);
  assert.equal((await source.select().from(monitors).all())[0].enabled, 1);
});

test("parseCopyLink sanitizes the computer name and accepts a link without one", () => {
  const from = encodeURIComponent("http://192.168.1.5:5000/abc");
  const named = parseCopyLink(`tracer://copy?from=${from}&key=k&name=${encodeURIComponent("Ann\u0000's\nMac" + "x".repeat(100))}`);
  assert.equal(named.name, "Ann'sMac" + "x".repeat(56));
  assert.equal(parseCopyLink(`tracer://copy?from=${from}&key=k`).name, undefined);
});

test("link carries the computer device id; parseCopyLink accepts only a plain one", () => {
  const from = encodeURIComponent("http://192.168.1.5:5000/abc");
  assert.equal(parseCopyLink(`tracer://copy?from=${from}&key=k&device=abc-123`).device, "abc-123");
  assert.equal(parseCopyLink(`tracer://copy?from=${from}&key=k&device=${encodeURIComponent("a b")}`).device, undefined);
  assert.equal(parseCopyLink(`tracer://copy?from=${from}&key=k`).device, undefined);
});

test("replace waits for approval, then copies and records the peer", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  assert.equal((await inspectCopy(phone, link)).mode, "replace");

  const done = receiveCopy(phone, link);
  await until(() => sendStatus().state === "approval");
  assert.equal(sendStatus().mode, "replace");
  assert.match(sendStatus().phoneName ?? "", /^iPhone /);
  approve();
  assert.equal((await done).mode, "replace");

  assert.equal((await phone.select().from(chatSessions).all()).length, 1);
  assert.equal(await setting(phone, "sync_peer_id"), await setting(computer, "device_id"));
  assert.ok(Number(await setting(phone, "sync_last_at")) > 0);
  assert.match((await setting(computer, "sync_peer_name")) ?? "", /^iPhone /);
});

test("merge keeps rows from both devices", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await receiveWithApproval(phone, (await startSend(computer, () => 0)).link);

  await computer.insert(chatSessions).values({ id: "only-computer", title: "C", messages: "[]", status: "done" }).run();
  await phone.insert(chatSessions).values({ id: "only-phone", title: "P", messages: "[]", status: "done" }).run();
  await phone.insert(providerConfigs).values({ type: "posthog", config: "{}" }).run();

  const reloads: boolean[] = [];
  const { link } = await startSend(computer, () => 0, async (providersChanged) => { reloads.push(providersChanged); });
  assert.equal((await inspectCopy(phone, link)).mode, "merge");
  assert.equal((await receiveWithApproval(phone, link)).mode, "merge");

  for (const db of [computer, phone]) {
    const ids = (await db.select().from(chatSessions).all()).map((r) => r.id).sort();
    assert.deepEqual(ids, ["only-computer", "only-phone", "s1"]);
  }
  assert.equal(sendStatus().state, "sent");
  assert.ok((sendStatus().applied ?? 0) >= 1);
  assert.equal(await setting(phone, "sync_peer_id"), await setting(computer, "device_id"));
  assert.match((await setting(computer, "sync_peer_name")) ?? "", /^iPhone /);
  assert.ok(Number(await setting(computer, "sync_last_at")) > 0);
  // The computer reloads its providers because the phone added one.
  assert.deepEqual(reloads, [true]);
});

test("replace refuses while an investigation runs on the computer", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 1);
  const done = receiveCopy(phone, link);
  await until(() => sendStatus().state === "approval");
  approve();
  await assert.rejects(done, /investigation is running/);
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
});

test("inspect returns merge only for the computer the phone synced with", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await phone.insert(appSettings).values({ key: "sync_peer_id", value: "someone-else" }).run();
  const { link } = await startSend(computer, () => 0);
  assert.equal((await inspectCopy(phone, link)).mode, "replace");
  await phone.update(appSettings).set({ value: (await setting(computer, "device_id"))! }).where(eq(appSettings.key, "sync_peer_id")).run();
  assert.equal((await inspectCopy(phone, link)).mode, "merge");
});

test("nothing is exchanged before approval; a second request gets 409", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const key = keyOf(link);
  const from = new URL(new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("from")!);
  const request = await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone 0001", mode: "merge" }), key);

  assert.equal((await post(link, "/request", await seal("{}", randomSecret()))).status, 403);
  assert.equal(sendStatus().state, "waiting");
  assert.equal((await fetch(from)).status, 403);

  assert.equal((await post(link, "/request", request)).status, 200);
  assert.equal(sendStatus().state, "approval");
  assert.equal((await post(link, "/request", request)).status, 409);
  assert.equal((await fetch(from)).status, 403);
  assert.equal((await post(link, "/merge", await seal("{}", key))).status, 403);
  assert.equal(((await (await fetch(new URL(from.pathname + "/status", from))).json()) as { state: string }).state, "approval");
});

test("deny ends the session and the phone sees why", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  const done = receiveCopy(phone, link);
  const outcome = assert.rejects(done, /denied/);
  await until(() => sendStatus().state === "approval");
  deny();
  await outcome;
  assert.equal(sendStatus().state, "denied");
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
});

test("merge refuses while an investigation runs", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await phone.insert(appSettings).values({ key: "sync_peer_id", value: (await setting(computer, "device_id"))! }).run();
  const { link } = await startSend(computer, () => 1);
  const done = receiveCopy(phone, link);
  const outcome = assert.rejects(done, /investigation is running/);
  await until(() => sendStatus().state === "approval");
  approve();
  await outcome;
});

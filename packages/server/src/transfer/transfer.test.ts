import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { appSettings, chatSessions, monitors, monitorTriggers, providerConfigs, syncRows } from "../db/schema.js";
import { limits, MAX_SYNC_BYTES, MAX_UNPACKED_BYTES, randomSecret, seal, TooLargeError, unseal } from "./crypto.js";
import { exportSnapshot, FORMAT, importSnapshot } from "./snapshot.js";
import { exportSyncPayload } from "./sync.js";
import { inspectCopy, parseCopyLink, receiveCopy } from "./receive.js";
import { approve, deny, sendStatus, startSend, stopSend } from "./send.js";
import { getMark, getSetting } from "./peer.js";
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

test("sealed data is compressed", async () => {
  const key = randomSecret();
  const text = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "checkout-service", status: "error" })));
  const sealed = await seal(text, key);
  assert.ok(sealed.length < text.length / 5);
  assert.equal(await unseal(sealed, key), text);
  assert.equal(await unseal(await seal("zażółć 🙂", key), key), "zażółć 🙂");
});

test("the limits apply to compressed and to unpacked data", async (t) => {
  const saved = { ...limits };
  t.after(() => Object.assign(limits, saved));
  assert.equal(limits.packed, MAX_SYNC_BYTES);
  assert.equal(limits.unpacked, MAX_UNPACKED_BYTES);
  const key = randomSecret();

  // Compresses to almost nothing, so only the unpacked limit can refuse it.
  limits.unpacked = 1000;
  await assert.rejects(seal("x".repeat(1001), key), /before compression/);
  limits.unpacked = saved.unpacked;
  const sealed = await seal("x".repeat(5000), key);
  limits.unpacked = 1000;
  await assert.rejects(unseal(sealed, key), (err: Error) => err instanceof TooLargeError && /when unpacked/.test(err.message));
  limits.unpacked = saved.unpacked;

  limits.packed = 1000;
  const noise = Array.from(crypto.getRandomValues(new Uint8Array(3000)), (b) => b.toString(16)).join("");
  await assert.rejects(seal(noise, key), (err: Error) => err instanceof TooLargeError && /after compression/.test(err.message));
});

test("replace of too much data fails on the phone with the size; the computer shows why", async (t) => {
  const saved = { ...limits };
  t.after(() => { Object.assign(limits, saved); stopSend(); });
  const computer = await seededDb();
  const phone = await freshDb();
  const noise = Array.from(crypto.getRandomValues(new Uint8Array(40000)), (b) => b.toString(16)).join("");
  await computer.insert(chatSessions).values({ id: "big", title: "Big", messages: noise, status: "done" }).run();
  limits.packed = 2000;
  const { link, fullCopy } = await startSend(computer, () => 0);
  assert.equal(fullCopy.fits, false);
  assert.equal(fullCopy.limitBytes, 2000);
  assert.ok(fullCopy.bytes > 2000);
  await assert.rejects(receiveWithApproval(phone, link), /data to sync is [\d.]+ MB after compression/);
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
  assert.equal(sendStatus().state, "failed");
  assert.match(sendStatus().error ?? "", /after compression/);
});

test("startSend returns an estimate of the compressed size of a full copy", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { fullCopy } = await startSend(computer, () => 0);
  assert.equal(fullCopy.fits, true);
  assert.equal(fullCopy.limitBytes, MAX_SYNC_BYTES);
  assert.ok(fullCopy.bytes > 0 && fullCopy.bytes < JSON.stringify(await exportSnapshot(computer)).length);
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

test("receiveCopy keeps the monitor toggles; the source stays active", async (t) => {
  t.after(stopSend);
  const source = await seededDb();
  const target = await freshDb();
  const { link } = await startSend(source, () => 0);
  await receiveWithApproval(target, link);
  assert.equal((await target.select().from(monitors).all())[0].enabled, 1);
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

test("a change logged after a sync mark is never older than the mark", async () => {
  const db = await freshDb();
  for (let i = 0; i < 500; i++) {
    const mark = Date.now();
    await db.insert(chatSessions).values({ id: `c${i}`, title: "T", messages: "[]", status: "done" }).run();
    const logged = await db.select().from(syncRows).where(eq(syncRows.rowKey, `c${i}`)).get();
    assert.ok(logged!.localAt >= mark, `logged ${logged!.localAt} before mark ${mark}`);
  }
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
  const request = await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone 0001", mode: "merge", format: FORMAT }), key);

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

// Syncs the phone with the computer once and returns the sealed request and response sizes.
async function syncOnce(computer: Awaited<ReturnType<typeof freshDb>>, phone: Awaited<ReturnType<typeof freshDb>>) {
  const { link } = await startSend(computer, () => 0);
  const realFetch = globalThis.fetch;
  const sizes: Record<string, number> = {};
  globalThis.fetch = (async (url: URL, init?: RequestInit) => {
    const response = await realFetch(url, init);
    const last = new URL(url).pathname.split("/").pop();
    const path = last === "merge" ? "merge" : last === "status" || last === "request" ? last : "copy";
    const text = await response.clone().text();
    if (path === "merge" || path === "copy") sizes[path] = text.length;
    if (path === "merge") sizes.sent = String(init?.body).length;
    return response;
  }) as typeof fetch;
  try {
    const result = await receiveWithApproval(phone, link);
    return { result, sizes };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function pairedDevices() {
  const computer = await seededDb();
  const phone = await freshDb();
  for (let i = 0; i < 20; i++) {
    const messages = JSON.stringify(Array.from({ length: 50 }, (_, j) => ({ q: j, rows: Array.from({ length: 20 }, (_, k) => ({ app: `svc-${k}`, count: i * j * k, message: `Error ${k} in checkout` })) })));
    await computer.insert(chatSessions).values({ id: `c${i}`, title: `Chat ${i}`, messages, status: "done" }).run();
  }
  const replace = await syncOnce(computer, phone);
  return { computer, phone, replace: replace.sizes.copy };
}

test("a second merge sends only the rows changed since the first", async (t) => {
  t.after(stopSend);
  const { computer, phone, replace } = await pairedDevices();
  const peer = (await setting(computer, "device_id"))!;
  assert.ok(await getMark(phone, peer));
  const first = await syncOnce(computer, phone);
  assert.equal(first.result.mode, "merge");

  await new Promise((r) => setTimeout(r, 5));
  await phone.update(chatSessions).set({ title: "Renamed" }).where(eq(chatSessions.id, "c3")).run();
  const mark = (await getMark(phone, peer))!;
  assert.deepEqual((await exportSyncPayload(phone, mark.mine)).rows.map((r) => r.row_key), ["c3"]);

  const second = await syncOnce(computer, phone);
  assert.ok(second.sizes.sent < replace / 5);
  assert.ok(second.sizes.merge < replace / 5);
  assert.equal((await computer.select().from(chatSessions).where(eq(chatSessions.id, "c3")).get())?.title, "Renamed");
});

test("a delete after the watermark carries over", async (t) => {
  t.after(stopSend);
  const { computer, phone } = await pairedDevices();
  await new Promise((r) => setTimeout(r, 5));
  await phone.delete(chatSessions).where(eq(chatSessions.id, "c1")).run();
  await syncOnce(computer, phone);
  assert.equal((await computer.select().from(chatSessions).where(eq(chatSessions.id, "c1")).all()).length, 0);
  await new Promise((r) => setTimeout(r, 5));
  await computer.delete(chatSessions).where(eq(chatSessions.id, "c2")).run();
  await syncOnce(computer, phone);
  assert.equal((await phone.select().from(chatSessions).where(eq(chatSessions.id, "c2")).all()).length, 0);
});

test("a second phone with the same computer still gets everything", async (t) => {
  t.after(stopSend);
  const { computer, phone } = await pairedDevices();
  const second = await freshDb();
  await syncOnce(computer, second);
  assert.equal((await second.select().from(chatSessions).all()).length, 21);
  await new Promise((r) => setTimeout(r, 5));
  await phone.insert(chatSessions).values({ id: "from-first", title: "F", messages: "[]", status: "done" }).run();
  await syncOnce(computer, phone);
  await syncOnce(computer, second);
  assert.equal((await second.select().from(chatSessions).where(eq(chatSessions.id, "from-first")).all()).length, 1);
});

test("the watermark does not advance on a failed exchange", async (t) => {
  t.after(stopSend);
  const { computer, phone } = await pairedDevices();
  const peer = (await setting(computer, "device_id"))!;
  const before = await getMark(phone, peer);
  await phone.insert(chatSessions).values({ id: "late", title: "L", messages: "[]", status: "done" }).run();
  const { link } = await startSend(computer, () => 1);
  await assert.rejects(receiveWithApproval(phone, link), /investigation is running/);
  assert.deepEqual(await getMark(phone, peer), before);
  await syncOnce(computer, phone);
  assert.equal((await computer.select().from(chatSessions).where(eq(chatSessions.id, "late")).all()).length, 1);
});

test("a change made on the computer during an exchange is sent next time", async (t) => {
  t.after(stopSend);
  const { computer, phone } = await pairedDevices();
  await new Promise((r) => setTimeout(r, 5));
  const { link } = await startSend(computer, () => 0, async () => {
    // Runs inside the exchange, after the computer read its changes.
    await computer.insert(chatSessions).values({ id: "during", title: "D", messages: "[]", status: "done" }).run();
  });
  await phone.insert(chatSessions).values({ id: "p", title: "P", messages: "[]", status: "done" }).run();
  await receiveWithApproval(phone, link);
  assert.equal((await phone.select().from(chatSessions).where(eq(chatSessions.id, "during")).all()).length, 0);
  await syncOnce(computer, phone);
  assert.equal((await phone.select().from(chatSessions).where(eq(chatSessions.id, "during")).all()).length, 1);
});

test("a changed child merges although its parent did not change", async (t) => {
  t.after(stopSend);
  const { computer, phone } = await pairedDevices();
  await computer.insert(monitors).values({ id: "m9", name: "M", query: "q", condition: "{}" }).run();
  await syncOnce(computer, phone);
  await new Promise((r) => setTimeout(r, 5));
  await phone.insert(monitorTriggers).values({ id: "t9", monitorId: "m9", triggeredAt: 1, value: 1, windowStart: 1, windowEnd: 2, status: "open", groups: "[]", sessionId: null }).run();
  await syncOnce(computer, phone);
  assert.equal((await computer.select().from(monitorTriggers).where(eq(monitorTriggers.id, "t9")).all()).length, 1);
});

test("an old phone gets a 409 with the update message", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const key = keyOf(link);
  // The old form: "iv.data", no compression, no format field.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify({ deviceId: "p-1", name: "iPhone", mode: "replace" })));
  const old = `${Buffer.from(iv).toString("base64url")}.${Buffer.from(data).toString("base64url")}`;
  const response = await post(link, "/request", old);
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Update Tracer on the phone/);
  const noFormat = await post(link, "/request", await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone", mode: "replace" }), key));
  assert.equal(noFormat.status, 409);
  assert.equal(sendStatus().state, "waiting");
});

test("a phone asks an old computer and is told to update it", async (t) => {
  const phone = await freshDb();
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => res.end(JSON.stringify({ state: "waiting" })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  // 127.0.0.1 is not a private LAN address for the phone: use the check through a local alias.
  const link = `tracer://copy?from=${encodeURIComponent(`http://192.168.1.5:${port}/t`)}&key=k`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: URL, init?: RequestInit) => realFetch(new URL(url.pathname, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await assert.rejects(receiveCopy(phone, link), /Update Tracer on the computer/);
});

test("an old-form reply to the phone gives the update message", async () => {
  const key = randomSecret();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode("{}"));
  await assert.rejects(unseal(`${Buffer.from(iv).toString("base64url")}.${Buffer.from(data).toString("base64url")}`, key), (err: Error) => err.constructor.name === "OldFormError");
  assert.equal(FORMAT, 3);
});

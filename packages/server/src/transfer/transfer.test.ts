import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { appSettings, chatSessions, monitors, monitorTriggers, providerConfigs, syncRows } from "../db/schema.js";
import { deriveSessionKey, limits, MAX_SYNC_BYTES, MAX_UNPACKED_BYTES, newExchangeKey, randomSecret, seal, TooLargeError, unseal, verificationCode } from "./crypto.js";
import { exportSnapshot, FORMAT, importSnapshot } from "./snapshot.js";
import { exportSyncPayload } from "./sync.js";
import { cancelReceive, inspectCopy, parseCopyLink, receiveStatus, startReceive } from "./receive.js";
import { approve, deny, sendStatus, startSend, stopSend } from "./send.js";
import { clearPairings, getMark, getPairing, getSetting, setPairing } from "./peer.js";
import { transferRouter } from "../trpc/routers/transfer.router.js";
import { eq } from "drizzle-orm";

const receiveCopy = async (...args: Parameters<typeof startReceive>) => (await startReceive(...args)).done;

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
  await until(() => sendStatus()?.phase === "approval");
  approve();
  return done;
}

const setting = (db: Awaited<ReturnType<typeof freshDb>>, key: string) => getSetting(db, key);
const post = (link: string, suffix: string, body: string) => {
  const from = new URL(new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("from")!);
  return fetch(new URL(from.pathname + suffix, from), { method: "POST", body });
};
/** Asks for the full copy as a phone does. Without a key of its own it uses the session key of the request the test sent. */
const pull = async (link: string, key = sessionKeys.get(link) ?? randomSecret()) => post(link, "", await seal("{}", key, "snapshot-request"));
/** Sends merge data as a phone does: the proof of the session key goes ahead of the body. */
const upload = async (link: string, body: string, key: string) => {
  const from = new URL(param(link, "from"));
  return fetch(new URL(from.pathname + "/merge", from), { method: "POST", body, headers: { "x-tracer-proof": await seal("{}", key, "merge-request") } });
};
const param = (link: string, name: string) => new URLSearchParams(link.slice(link.indexOf("?") + 1)).get(name)!;
const keyOf = (link: string) => param(link, "key");
type TestDb = Awaited<ReturnType<typeof freshDb>>;
const deviceId = async (db: TestDb) => (await setting(db, "device_id"))!;

/** Stores one pairing secret on both devices, as a first sync does. */
async function pair(computer: TestDb, phone: TestDb) {
  const secret = randomSecret();
  await setPairing(computer, await deviceId(phone), secret);
  await setPairing(phone, await deviceId(computer), secret, true);
  return secret;
}

// Link -> the session key of the request the test sent as a phone.
const sessionKeys = new Map<string, string>();

/** Sends the request as a phone does. `pk` and `hello` replace the honest values. */
async function ask(link: string, mode: "merge" | "replace", { phone = "p-1", pairing, hello, format = FORMAT }: { phone?: string; pairing?: string; hello?: string; format?: number } = {}) {
  const exchange = await newExchangeKey();
  const key = await deriveSessionKey(exchange.privateKey, param(link, "pk"), { key: keyOf(link), pairing, mode, computer: param(link, "device"), phone });
  const body = await seal(JSON.stringify({ deviceId: phone, name: "iPhone 0001", mode, format, pk: exchange.publicKey, hello: hello ?? await seal("{}", key, "hello") }), keyOf(link), "request");
  const response = await post(link, "/request", body);
  const text = await response.text();
  if (response.status === 200) sessionKeys.set(link, key);
  return { status: response.status, text, key, body };
}

test("seal and unseal round-trip; a wrong key fails", async () => {
  const key = randomSecret();
  const sealed = await seal("hello", key, "request");
  assert.equal(await unseal(sealed, key, "request"), "hello");
  await assert.rejects(unseal(sealed, randomSecret(), "request"));
});

test("a message sealed for one purpose does not open as another", async () => {
  const key = randomSecret();
  const sealed = await seal("{}", key, "merge-up");
  await assert.rejects(unseal(sealed, key, "merge-down"));
  await assert.rejects(unseal(sealed, key, "progress"));
  assert.equal(await unseal(sealed, key, "merge-up"), "{}");
});

test("sealed data is compressed", async () => {
  const key = randomSecret();
  const text = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "checkout-service", status: "error" })));
  const sealed = await seal(text, key, "snapshot");
  assert.ok(sealed.length < text.length / 5);
  assert.equal(await unseal(sealed, key, "snapshot"), text);
  assert.equal(await unseal(await seal("zażółć 🙂", key, "snapshot"), key, "snapshot"), "zażółć 🙂");
});

test("the limits apply to compressed and to unpacked data", async (t) => {
  const saved = { ...limits };
  t.after(() => Object.assign(limits, saved));
  assert.equal(limits.packed, MAX_SYNC_BYTES);
  assert.equal(limits.unpacked, MAX_UNPACKED_BYTES);
  const key = randomSecret();

  // Compresses to almost nothing, so only the unpacked limit can refuse it.
  limits.unpacked = 1000;
  await assert.rejects(seal("x".repeat(1001), key, "snapshot"), /before compression/);
  limits.unpacked = saved.unpacked;
  const sealed = await seal("x".repeat(5000), key, "snapshot");
  limits.unpacked = 1000;
  await assert.rejects(unseal(sealed, key, "snapshot"), (err: Error) => err instanceof TooLargeError && /when unpacked/.test(err.message));
  limits.unpacked = saved.unpacked;

  limits.packed = 1000;
  const noise = Array.from(crypto.getRandomValues(new Uint8Array(3000)), (b) => b.toString(16)).join("");
  await assert.rejects(seal(noise, key, "snapshot"), (err: Error) => err instanceof TooLargeError && /after compression/.test(err.message));
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
  assert.equal(sendStatus()?.phase, "failed");
  assert.equal(sendStatus()?.error?.side, "computer");
  assert.match(sendStatus()?.error?.message ?? "", /after compression/);
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
  assert.equal(sendStatus()?.phase, "waiting");

  await receiveWithApproval(target, link);
  assert.equal(sendStatus()?.phase, "done");
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

test("the link carries the computer's exchange key; a code without one comes from an older computer", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  assert.match(parseCopyLink(link).pk ?? "", /^[A-Za-z0-9_-]{87}$/);
  const old = link.replace(/&pk=[^&]*/, "");
  assert.equal(parseCopyLink(old).pk, undefined);
  await assert.rejects(inspectCopy(phone, old), /Update Tracer on the computer/);
  await assert.rejects(startReceive(phone, old), /Update Tracer on the computer/);
  assert.equal(sendStatus()?.phase, "waiting");
});

test("replace waits for approval, then copies and records the peer", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  assert.equal((await inspectCopy(phone, link)).mode, "replace");

  const done = receiveCopy(phone, link);
  await until(() => sendStatus()?.phase === "approval");
  assert.equal(sendStatus()?.mode, "replace");
  assert.match(sendStatus()?.phoneName ?? "", /^iPhone /);
  approve();
  assert.equal((await done).mode, "replace");

  assert.equal((await phone.select().from(chatSessions).all()).length, 1);
  assert.equal(await setting(phone, "sync_peer_id"), await setting(computer, "device_id"));
  assert.ok(Number(await setting(phone, "sync_last_at")) > 0);
  assert.match((await setting(computer, "sync_peer_name")) ?? "", /^iPhone /);
  const secret = await getPairing(phone, await deviceId(computer));
  assert.match(secret ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await getPairing(computer, await deviceId(phone)), secret);
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
  assert.equal(sendStatus()?.phase, "done");
  assert.ok((sendStatus()?.result?.computer?.applied ?? 0) >= 1);
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
  await until(() => sendStatus()?.phase === "approval");
  approve();
  await assert.rejects(done, /investigation is running/);
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
  assert.deepEqual([sendStatus()?.phase, sendStatus()?.error?.side], ["failed", "computer"]);
  assert.equal(receiveStatus()?.error?.side, "computer");
});

test("inspect returns merge only when the phone holds the pairing secret of the computer", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await setPairing(phone, "someone-else", randomSecret(), true);
  const { link } = await startSend(computer, () => 0);
  assert.deepEqual([(await inspectCopy(phone, link)).mode, (await inspectCopy(phone, link)).pairedBefore], ["replace", false]);
  // The phone synced with this computer under an older version: the id is stored, but no secret.
  await phone.insert(appSettings).values({ key: "sync_peer_id", value: await deviceId(computer) }).run();
  assert.deepEqual([(await inspectCopy(phone, link)).mode, (await inspectCopy(phone, link)).pairedBefore], ["replace", true]);
  await pair(computer, phone);
  assert.deepEqual([(await inspectCopy(phone, link)).mode, (await inspectCopy(phone, link)).pairedBefore], ["merge", false]);
});

test("nothing is exchanged before approval; a second request gets 409", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const key = keyOf(link);
  const from = new URL(param(link, "from"));
  const secret = randomSecret();
  await setPairing(computer, "p-1", secret);

  assert.equal((await post(link, "/request", await seal("{}", randomSecret(), "request"))).status, 403);
  // A message of another kind does not pass as a request.
  assert.equal((await post(link, "/request", await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone 0001", mode: "replace", format: FORMAT, pk: "x", hello: "x" }), key, "progress"))).status, 403);
  // A request without a working exchange key or proof does not pass.
  assert.equal((await post(link, "/request", await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone 0001", mode: "replace", format: FORMAT, pk: "x", hello: "x" }), key, "request"))).status, 403);
  assert.equal((await post(link, "/request", await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone 0001", mode: "replace", format: FORMAT }), key, "request"))).status, 400);
  assert.equal(sendStatus()?.phase, "waiting");
  assert.equal((await pull(link)).status, 403);

  const asked = await ask(link, "merge", { pairing: secret });
  assert.equal(asked.status, 200);
  assert.equal(sendStatus()?.phase, "approval");
  assert.equal((await post(link, "/request", asked.body)).status, 409);
  assert.equal((await pull(link)).status, 403);
  assert.equal((await post(link, "/merge", await seal("{}", asked.key, "merge-up"))).status, 403);
  assert.equal((await statusOf(link))?.phase, "approval");
  // The key from the QR code alone opens nothing after the request.
  const sealed = ((await (await fetch(new URL(from.pathname + "/status", from))).json()) as { sealed: string }).sealed;
  await assert.rejects(unseal(sealed, key, "status"));
});

test("deny ends the session and the phone sees why", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  const done = receiveCopy(phone, link);
  const outcome = assert.rejects(done, /denied/);
  await until(() => sendStatus()?.phase === "approval");
  deny();
  await outcome;
  assert.equal(sendStatus()?.phase, "denied");
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
});

test("merge refuses while an investigation runs", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await pair(computer, phone);
  const { link } = await startSend(computer, () => 1);
  const done = receiveCopy(phone, link);
  const outcome = assert.rejects(done, /investigation is running/);
  await until(() => sendStatus()?.phase === "approval");
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
    const path = last === "merge" ? "merge" : last === "status" || last === "request" || last === "progress" || last === "cancel" ? last : "copy";
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
  const noFormat = await post(link, "/request", await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone", mode: "replace" }), key, "request"));
  assert.equal(noFormat.status, 409);
  // The previous version: the same seal, a lower format, no exchange key.
  const previous = await post(link, "/request", await seal(JSON.stringify({ deviceId: "p-1", name: "iPhone", mode: "merge", format: FORMAT - 1 }), key, "request"));
  assert.equal(previous.status, 409);
  assert.match(await previous.text(), /Update Tracer on the phone/);
  const newer = await ask(link, "replace", { format: FORMAT + 1 });
  assert.equal(newer.status, 409);
  assert.match(newer.text, /Update Tracer on this computer/);
  // The form before the labels: "z.iv.data".
  const unlabelled = await post(link, "/request", `z.${old}`);
  assert.equal(unlabelled.status, 409);
  assert.match(await unlabelled.text(), /Update Tracer on the phone/);
  assert.equal(sendStatus()?.phase, "waiting");
});

test("a phone asks an old computer and is told to update it", async (t) => {
  const phone = await freshDb();
  const { createServer } = await import("node:http");
  // The oldest computers report no format; later ones report a lower one.
  let reply: object = { phase: "waiting" };
  const server = createServer((_req, res) => res.end(JSON.stringify(reply)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  // 127.0.0.1 is not a private LAN address for the phone: use the check through a local alias.
  const link = `tracer://copy?from=${encodeURIComponent(`http://192.168.1.5:${port}/t`)}&key=${randomSecret()}&device=c-1&pk=${(await newExchangeKey()).publicKey}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: URL, init?: RequestInit) => realFetch(new URL(url.pathname, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  await assert.rejects(receiveCopy(phone, link), /Update Tracer on the computer/);
  reply = { phase: "waiting", format: FORMAT - 1 };
  await assert.rejects(receiveCopy(phone, link), /Update Tracer on the computer/);
  reply = { format: FORMAT + 1, sealed: "x" };
  await assert.rejects(receiveCopy(phone, link), /Update Tracer on the phone/);
  // A computer of this format that cannot seal its answer with the session key is not trusted.
  reply = { phase: "transfer", format: FORMAT };
  await assert.rejects(receiveCopy(phone, link), /does not decrypt/);
});

test("a phone on the previous version reads the status of this computer as a newer format", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  const from = new URL(new URLSearchParams(link.slice(link.indexOf("?") + 1)).get("from")!);
  const plain = (await (await fetch(new URL(from.pathname + "/status", from))).json()) as { format: number; phase?: string };
  assert.equal(plain.format, FORMAT);
  assert.equal(plain.phase, undefined);
});

test("an old-form reply to the phone gives the update message", async () => {
  const key = randomSecret();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), "AES-GCM", false, ["encrypt"]);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode("{}"));
  const old = `${Buffer.from(iv).toString("base64url")}.${Buffer.from(data).toString("base64url")}`;
  await assert.rejects(unseal(old, key, "snapshot"), (err: Error) => err.constructor.name === "OldFormError");
  await assert.rejects(unseal(`z.${old}`, key, "snapshot"), (err: Error) => err.constructor.name === "OldFormError");
  assert.equal(FORMAT, 7);
});

const report = async (link: string, body: object) => post(link, "/progress", await seal(JSON.stringify(body), sessionKeys.get(link)!, "progress"));
async function statusOf(link: string) {
  const from = new URL(param(link, "from"));
  const { format, sealed } = (await (await fetch(new URL(from.pathname + "/status", from))).json()) as { format: number; sealed: string };
  return { ...(JSON.parse(await unseal(sealed, sessionKeys.get(link) ?? keyOf(link), "status")) as NonNullable<ReturnType<typeof sendStatus>>), format };
}

test("the shared status runs waiting, approval, transfer, apply; only the phone report ends it", async (t) => {
  t.after(stopSend);
  const { link, session } = await startSend(await seededDb(), () => 0);
  assert.equal(session.phase, "waiting");
  assert.ok(session.expiresAt > Date.now());
  assert.equal((await statusOf(link)).format, FORMAT);

  assert.equal((await ask(link, "replace")).status, 200);
  const asked = await statusOf(link);
  assert.deepEqual([asked?.phase, asked?.mode, asked?.phoneName], ["approval", "replace", "iPhone 0001"]);
  // The phone cannot report before the computer allowed the request.
  assert.equal((await report(link, { phase: "done" })).status, 409);

  approve();
  assert.equal((await statusOf(link))?.phase, "transfer");
  const data = await pull(link);
  assert.equal(data.status, 200);
  assert.equal(Number(data.headers.get("content-length")), (await data.text()).length);
  await until(() => sendStatus()?.phase === "apply");
  // The computer sent everything, but the phone has not saved it.
  assert.equal((await report(link, { phase: "done", result: { applied: 3, deleted: 1 } })).status, 200);
  const done = await statusOf(link);
  assert.equal(done?.phase, "done");
  assert.deepEqual(done?.result, { computer: { applied: 0, deleted: 0 }, phone: { applied: 3, deleted: 1 } });
});

test("a failure the phone reports shows on the computer with the side phone", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  await ask(link, "replace");
  approve();
  assert.equal((await report(link, { phase: "failed", error: "No space left on the phone." })).status, 200);
  const status = await statusOf(link);
  assert.equal(status?.phase, "failed");
  assert.deepEqual(status?.error, { message: "No space left on the phone.", side: "phone" });
});

test("a merge that fails while the phone saves tells the computer it saved its part", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await receiveWithApproval(phone, (await startSend(computer, () => 0)).link);
  await computer.insert(chatSessions).values({ id: "only-computer", title: "C", messages: "[]", status: "done" }).run();

  const { link } = await startSend(computer, () => 0);
  const { done } = await startReceive(phone, link, () => { throw new Error("An investigation is running."); });
  done.catch(() => {});
  await until(() => sendStatus()?.phase === "approval");
  approve();
  await assert.rejects(done, /investigation is running/);
  assert.equal(sendStatus()?.phase, "failed");
  assert.deepEqual(sendStatus()?.error, { message: "An investigation is running.", side: "phone" });
  assert.equal(sendStatus()?.mode, "merge");
  assert.ok(sendStatus()?.result?.computer);
  assert.deepEqual([receiveStatus()?.phase, receiveStatus()?.error?.side], ["failed", "phone"]);
});

test("the phone view follows the sync and shows the bytes and both counts", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  const { done, session } = await startReceive(phone, link);
  assert.equal(session.phase, "approval");
  assert.equal(session.mode, "replace");
  await until(() => sendStatus()?.phase === "approval");
  approve();
  await done;
  const view = receiveStatus()!;
  assert.equal(view.phase, "done");
  assert.ok(view.bytes && view.bytes.total > 0 && view.bytes.done === view.bytes.total);
  assert.deepEqual(sendStatus()?.bytes, view.bytes);
  assert.deepEqual(view.result?.computer, { applied: 0, deleted: 0 });
  assert.ok((view.result?.phone?.applied ?? 0) > 0);
  assert.deepEqual(sendStatus()?.result, view.result);
});

test("a cancel on the phone ends the sync on the computer", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  const phone = await freshDb();
  const { done } = await startReceive(phone, link);
  const outcome = assert.rejects(done);
  await until(() => sendStatus()?.phase === "approval");
  await cancelReceive();
  await outcome;
  assert.equal(sendStatus()?.phase, "cancelled");
  assert.equal(sendStatus()?.error?.side, "phone");
  assert.equal(receiveStatus()?.phase, "cancelled");
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
});

test("a cancel on the phone before the computer's answer arrives ends the approval prompt", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: URL, init?: RequestInit) => {
    if (!url.pathname.endsWith("/request")) return realFetch(url, init);
    await realFetch(url, { ...init, signal: undefined });
    // The answer never reaches the phone.
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  }) as typeof fetch;
  const { done } = await startReceive(await freshDb(), link);
  const outcome = assert.rejects(done, /cancelled/);
  await until(() => sendStatus()?.phase === "approval");
  await cancelReceive();
  await outcome;
  assert.equal(sendStatus()?.phase, "cancelled");
  assert.equal(sendStatus()?.reached, "approval");
  assert.deepEqual(sendStatus()?.error, { message: "Cancelled on the phone.", side: "phone" });
  assert.equal(receiveStatus()?.phase, "cancelled");
});

test("a cancel sealed with the key from the code ends the prompt for that phone only, and nothing after Allow", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const cancel = async (link: string, phone: string) => (await post(link, "/cancel", await seal(JSON.stringify({ deviceId: phone }), keyOf(link), "cancel-request"))).status;

  const first = await startSend(computer, () => 0);
  assert.equal(await cancel(first.link, "p-1"), 403);
  assert.equal(sendStatus()?.phase, "waiting");
  await ask(first.link, "replace");
  assert.equal(await cancel(first.link, "p-2"), 403);
  assert.equal(sendStatus()?.phase, "approval");
  approve();
  assert.equal(await cancel(first.link, "p-1"), 403);
  assert.equal(sendStatus()?.phase, "transfer");
  assert.equal((await pull(first.link)).status, 200);

  const second = await startSend(computer, () => 0);
  await ask(second.link, "replace");
  assert.equal(await cancel(second.link, "p-1"), 200);
  assert.equal(sendStatus()?.phase, "cancelled");
  assert.deepEqual(sendStatus()?.error, { message: "Cancelled on the phone.", side: "phone" });
});

test("a cancel on the computer shows as cancelled on the phone, not as expired", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  const { done } = await startReceive(await freshDb(), link);
  const outcome = assert.rejects(done, /cancelled/);
  await until(() => sendStatus()?.phase === "approval");
  stopSend();
  await outcome;
  assert.equal(receiveStatus()?.phase, "cancelled");
  assert.deepEqual(receiveStatus()?.error, { message: "Cancelled on the computer.", side: "computer" });
  // The listener still answers for a moment after the end.
  const from = new URL(param(link, "from"));
  assert.equal((await fetch(new URL(from.pathname + "/status", from))).status, 200);
});

test("only one sync runs on the phone at a time", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  const phone = await freshDb();
  const { done } = await startReceive(phone, link);
  done.catch(() => {});
  await assert.rejects(startReceive(phone, link), /already running/);
  stopSend();
  await done.catch(() => {});
});

test("a cancel on the computer during the transfer stops the phone before it writes", async (t) => {
  t.after(stopSend);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const { link } = await startSend(await seededDb(), () => 0);
  const phone = await freshDb();
  globalThis.fetch = (async (url: URL, init?: RequestInit) => {
    const response = await realFetch(url, init);
    // The data request: the token is the only path segment.
    if (new URL(url).pathname.split("/").length === 2) stopSend();
    return response;
  }) as typeof fetch;
  await assert.rejects(receiveWithApproval(phone, link), /computer cancelled/);
  assert.equal((await phone.select().from(chatSessions).all()).length, 0);
  assert.equal(receiveStatus()?.phase, "cancelled");
});

/** Replaces the computer's answer to the merge request with `answer(sent body)`. */
function swapMergeReply(t: { after(fn: () => void): void }, answer: (sent: string) => string | Promise<string>) {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: URL, init?: RequestInit) => {
    const response = await realFetch(url, init);
    if (!new URL(url).pathname.endsWith("/merge")) return response;
    await response.text();
    return new Response(await answer(String(init?.body)), { status: 200 });
  }) as typeof fetch;
}

async function mergeReady(t: { after(fn: () => void): void }) {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await receiveWithApproval(phone, (await startSend(computer, () => 0)).link);
  const peer = (await setting(computer, "device_id"))!;
  await computer.insert(chatSessions).values({ id: "only-computer", title: "C", messages: "[]", status: "done" }).run();
  const { link } = await startSend(computer, () => 0);
  return { computer, phone, link, peer, before: await getMark(phone, peer) };
}

test("the phone rejects its own merge request sent back as the reply and keeps the sync mark", async (t) => {
  const { phone, link, peer, before } = await mergeReady(t);
  swapMergeReply(t, (sent) => sent);
  await assert.rejects(receiveWithApproval(phone, link), /does not decrypt/);
  assert.deepEqual(await getMark(phone, peer), before);
  assert.equal((await phone.select().from(chatSessions).where(eq(chatSessions.id, "only-computer")).all()).length, 0);
});

type Seen = { route: string; body: string };
const nativeFetch = globalThis.fetch;

/**
 * A host at the address of a code that is not Tracer on the paired computer. It holds every part of the link.
 * With `pairing` it also holds the secret and allows the request at once.
 */
async function fakeComputer(t: { after(fn: () => void): void }, options: {
  pairing?: string;
  welcome?: (hello: string) => string;
  merge?: (sessionKey: string) => Promise<string>;
} = {}) {
  const { createServer } = await import("node:http");
  const exchange = await newExchangeKey();
  const key = randomSecret();
  const seen: Seen[] = [];
  let sessionKey = "";
  const server = createServer((req, res) => {
    void (async () => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const route = `${req.method} ${req.url}`;
      seen.push({ route, body });
      if (route === "GET /t/status") {
        const view = { phase: "transfer", computerName: "Mac", expiresAt: Date.now() + 60_000 };
        return res.end(JSON.stringify({ format: FORMAT, sealed: sessionKey ? await seal(JSON.stringify(view), sessionKey, "status") : "x" }));
      }
      if (route === "POST /t/request") {
        const request = JSON.parse(await unseal(body, key, "request")) as { deviceId: string; mode: "merge" | "replace"; pk: string; hello: string };
        // Without the secret the host can only guess one.
        const pairing = request.mode === "merge" ? options.pairing ?? randomSecret() : undefined;
        sessionKey = await deriveSessionKey(exchange.privateKey, request.pk, { key, pairing, mode: request.mode, computer: "c-1", phone: request.deviceId });
        return res.end(options.welcome ? options.welcome(request.hello) : await seal("{}", sessionKey, "welcome"));
      }
      if (route === "POST /t/merge" && options.merge) return res.end(await options.merge(sessionKey));
      res.statusCode = 404;
      res.end();
    })().catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  globalThis.fetch = ((url: URL, init?: RequestInit) => nativeFetch(new URL(url.pathname, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  t.after(() => { globalThis.fetch = nativeFetch; server.close(); });
  const link = `tracer://copy?from=${encodeURIComponent(`http://192.168.1.5:${port}/t`)}&key=${key}&name=Mac&device=c-1&pk=${exchange.publicKey}`;
  return { link, key, seen };
}

/** A phone with rows of its own that is paired with the computer "c-1". */
async function phonePairedWithC1() {
  const phone = await seededDb();
  const secret = randomSecret();
  await setPairing(phone, "c-1", secret, true);
  await phone.insert(appSettings).values({ key: "sync_peer_id", value: "c-1" }).run();
  return { phone, secret };
}

test("the phone rejects a reply without a time before it writes anything", async (t) => {
  const { phone, secret } = await phonePairedWithC1();
  const other = await freshDb();
  await other.insert(chatSessions).values({ id: "only-computer", title: "C", messages: "[]", status: "done" }).run();
  const { link } = await fakeComputer(t, { pairing: secret, merge: async (key) => seal(JSON.stringify({ at: "soon", payload: await exportSyncPayload(other) }), key, "merge-down") });
  await assert.rejects(receiveCopy(phone, link), /data from the computer is damaged/);
  assert.equal(await getMark(phone, "c-1"), undefined);
  assert.equal((await phone.select().from(chatSessions).where(eq(chatSessions.id, "only-computer")).all()).length, 0);
});

test("a merge with a host that lacks the pairing secret ends before the phone sends a row", async (t) => {
  const answers: Record<string, ((hello: string) => string) | undefined> = {
    "a guessed secret": undefined,
    "the phone's own proof sent back": (hello) => hello,
    "an empty answer": () => "",
  };
  for (const [name, welcome] of Object.entries(answers)) {
    const { phone, secret } = await phonePairedWithC1();
    const { link, key, seen } = await fakeComputer(t, { welcome, merge: async () => "x" });
    assert.equal((await inspectCopy(phone, link)).mode, "merge", name);
    await assert.rejects(receiveCopy(phone, link), /did not prove that it is the computer this phone is paired with/, name);

    // Only the version check and the request left the phone: no rows, no report, no cancel.
    assert.deepEqual(seen.map((r) => r.route), ["GET /t/status", "POST /t/request"], name);
    const request = JSON.parse(await unseal(seen[1].body, key, "request")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(request).sort(), ["deviceId", "format", "hello", "mode", "name", "pk"], name);
    assert.ok(!JSON.stringify(request).includes(secret), name);
    assert.equal(receiveStatus()?.phase, "failed", name);
    assert.equal(receiveStatus()?.code, undefined, name);
    // What the host says never clears the pairing or changes the mode.
    assert.equal(await getPairing(phone, "c-1"), secret, name);
    assert.equal((await inspectCopy(phone, link)).mode, "merge", name);
    assert.equal((await phone.select().from(chatSessions).all()).length, 1, name);
  }
});

test("a host that holds the QR parts but not the pairing secret cannot answer a paired phone, whatever status it returns", async (t) => {
  const { phone } = await phonePairedWithC1();
  const { link, seen } = await fakeComputer(t, { welcome: () => "a.x.y" });
  await assert.rejects(receiveCopy(phone, link), /did not prove/);
  assert.ok(seen.every((r) => r.route !== "POST /t/merge"));
});

test("the computer refuses a merge whose data has the wrong shape and stays unchanged", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const secret = randomSecret();
  await setPairing(computer, "p-1", secret);
  const { key } = await ask(link, "merge", { pairing: secret });
  approve();
  const response = await upload(link, await seal(JSON.stringify({ payload: { format: FORMAT, tables: { chat_sessions: "x" }, rows: [] } }), key, "merge-up"), key);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /invalid row in chat_sessions/);
  assert.deepEqual([sendStatus()?.phase, sendStatus()?.error?.side], ["failed", "computer"]);
  assert.match(sendStatus()?.error?.message ?? "", /invalid row in chat_sessions/);
  assert.equal((await computer.select().from(chatSessions).all()).length, 1);
});

test("a merge request from an unknown phone, or from the right phone without the secret, is refused and changes nothing", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const hook = JSON.stringify({ webhookUrl: "https://hooks.slack.com/services/T0/B0/real" });
  await computer.insert(appSettings).values({ key: "integration:slack", value: hook }).run();
  await receiveWithApproval(phone, (await startSend(computer, () => 0)).link);
  const pairings = await setting(computer, "sync_pairings");
  const rows = JSON.stringify(await exportSnapshot(computer));

  const { link } = await startSend(computer, () => 0);
  const stranger = await ask(link, "merge", { phone: "stranger", pairing: randomSecret() });
  const wrongSecret = await ask(link, "merge", { phone: await deviceId(phone), pairing: randomSecret() });
  // A proof made for a replace does not pass as the proof of a merge.
  const replaceKey = await ask(link, "merge", { phone: await deviceId(phone), pairing: randomSecret(), hello: await seal("{}", randomSecret(), "hello") });
  for (const refused of [stranger, wrongSecret, replaceKey]) {
    assert.equal(refused.status, 409);
    assert.match(refused.text, /does not hold a pairing with this phone/);
    assert.equal(refused.text, stranger.text);
  }
  // No Allow prompt, no code, and the code on the screen still works for the real phone.
  assert.deepEqual([sendStatus()?.phase, sendStatus()?.phoneName, sendStatus()?.code], ["waiting", undefined, undefined]);
  assert.equal((await post(link, "/merge", await seal(JSON.stringify({ payload: await exportSyncPayload(phone) }), stranger.key, "merge-up"))).status, 403);
  assert.equal(await setting(computer, "sync_pairings"), pairings);
  assert.equal(JSON.stringify(await exportSnapshot(computer)), rows);
  assert.equal(await setting(computer, "integration:slack"), hook);
  assert.equal((await receiveWithApproval(phone, link)).mode, "merge");
});

test("devices paired by an older version replace once, then merge", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  // What the older version stored: the id of the other device, no secret.
  await phone.insert(appSettings).values({ key: "sync_peer_id", value: await deviceId(computer) }).run();
  await phone.insert(chatSessions).values({ id: "only-phone", title: "P", messages: "[]", status: "done" }).run();

  const first = await startSend(computer, () => 0);
  // The phone's id alone gets no merge from the computer.
  assert.equal((await ask(first.link, "merge", { phone: await deviceId(phone), pairing: randomSecret() })).status, 409);
  assert.deepEqual(await inspectCopy(phone, first.link), { mode: "replace", name: (await inspectCopy(phone, first.link)).name, address: (await inspectCopy(phone, first.link)).address, pairedBefore: true });
  assert.equal((await receiveWithApproval(phone, first.link)).mode, "replace");
  assert.equal(sendStatus()?.mode, "replace");
  assert.equal((await phone.select().from(chatSessions).where(eq(chatSessions.id, "only-phone")).all()).length, 0);
  assert.ok(await getPairing(phone, await deviceId(computer)));

  const second = await startSend(computer, () => 0);
  assert.deepEqual([(await inspectCopy(phone, second.link)).mode, (await inspectCopy(phone, second.link)).pairedBefore], ["merge", false]);
  assert.equal((await receiveWithApproval(phone, second.link)).mode, "merge");
});

test("the pairing secret stays on the two devices: no snapshot, payload, change log, status or route carries it", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await receiveWithApproval(phone, (await startSend(computer, () => 0)).link);
  const secret = (await getPairing(phone, await deviceId(computer)))!;
  assert.equal(await getPairing(computer, await deviceId(phone)), secret);

  // A second phone gets a full copy and its own secret, never the first one.
  const second = await freshDb();
  const { link } = await startSend(computer, () => 0);
  const done = receiveCopy(second, link);
  await until(() => sendStatus()?.phase === "approval");
  const views = [JSON.stringify(sendStatus()), JSON.stringify(receiveStatus()), JSON.stringify(await inspectCopy(second, link)), link];
  approve();
  await done;
  const secondSecret = (await getPairing(second, await deviceId(computer)))!;
  assert.notEqual(secondSecret, secret);
  assert.equal(await getPairing(computer, await deviceId(phone)), secret);
  assert.equal(await getPairing(computer, await deviceId(second)), secondSecret);
  assert.equal((await second.select().from(appSettings).all()).filter((r) => r.value.includes(secret)).length, 0);

  // A merge of the first phone after both pairings exist.
  await phone.insert(chatSessions).values({ id: "p2", title: "P", messages: "[]", status: "done" }).run();
  assert.equal((await receiveWithApproval(phone, (await startSend(computer, () => 0)).link)).mode, "merge");
  views.push(JSON.stringify(sendStatus()), JSON.stringify(receiveStatus()));

  for (const db of [computer, phone, second]) {
    const api = transferRouter.createCaller({ db, receivesCopy: true, isOwner: true } as never);
    views.push(
      JSON.stringify(await exportSnapshot(db)),
      JSON.stringify(await exportSyncPayload(db)),
      JSON.stringify(await exportSyncPayload(db, 0)),
      JSON.stringify(await db.select().from(syncRows).all()),
      JSON.stringify(await api.lastSync()),
      JSON.stringify(await api.receiveStatus()),
    );
  }
  views.push(JSON.stringify(await transferRouter.createCaller({ db: computer, isOwner: true } as never).sendStatus()));
  for (const view of views) {
    assert.ok(!view.includes(secret) && !view.includes(secondSecret) && !view.includes("sync_pairings"), view.slice(0, 200));
  }
  assert.equal((await transferRouter.createCaller({ db: phone, receivesCopy: true, isOwner: true } as never).lastSync())?.paired, true);
});

test("a snapshot cannot plant a pairing or another device setting", async () => {
  const source = await seededDb();
  const target = await freshDb();
  const snapshot = JSON.parse(JSON.stringify(await exportSnapshot(source))) as Awaited<ReturnType<typeof exportSnapshot>>;
  snapshot.tables.app_settings.push({ key: "sync_pairings", value: JSON.stringify({ "other-device": randomSecret() }), updatedAt: 1 });
  await importSnapshot(target, snapshot);
  assert.equal(await setting(target, "sync_pairings"), undefined);
});

test("both devices show the same code; another request gives another code", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  const { link } = await startSend(computer, () => 0);
  assert.equal(sendStatus()?.code, undefined);
  const { done } = await startReceive(phone, link);
  await until(() => sendStatus()?.phase === "approval" && !!receiveStatus()?.code);
  const code = sendStatus()!.code!;
  assert.match(code, /^\d{6}$/);
  assert.equal(receiveStatus()?.code, code);
  approve();
  await done;

  // Someone who saw the QR code asks first: the computer shows the code of that request.
  const next = await startSend(computer, () => 0);
  const stranger = await ask(next.link, "replace");
  assert.equal(stranger.status, 200);
  assert.equal(sendStatus()?.code, await verificationCode(stranger.key, stranger.body));
  // The session key enters the code, so the request alone does not give it.
  assert.notEqual(await verificationCode(randomSecret(), stranger.body), sendStatus()?.code);
  // The real phone is refused and shows no code, so the two screens never agree.
  await assert.rejects(receiveCopy(phone, next.link), /Another device already used this code.*click Deny/);
  assert.equal(receiveStatus()?.code, undefined);

  const third = await startSend(computer, () => 0);
  const again = await ask(third.link, "replace");
  assert.notEqual(await verificationCode(again.key, again.body), await verificationCode(stranger.key, stranger.body));
});

test("the key from the QR code alone does not open an allowed sync", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const { key } = await ask(link, "replace");
  approve();
  const sealed = await (await pull(link, key)).text();
  await assert.rejects(unseal(sealed, keyOf(link), "snapshot"));
  const opened = JSON.parse(await unseal(sealed, key, "snapshot")) as { pairing: string; snapshot: { tables: Record<string, unknown[]> } };
  assert.equal(opened.pairing, await getPairing(computer, "p-1"));
  assert.equal(opened.snapshot.tables.chat_sessions.length, 1);
  // Reports sealed with the QR key are refused too.
  assert.equal((await post(link, "/progress", await seal(JSON.stringify({ phase: "done" }), keyOf(link), "progress"))).status, 403);
  assert.equal((await post(link, "/cancel", await seal("{}", keyOf(link), "cancel"))).status, 403);
});

test("a phone that forgets the computer replaces at the next sync", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const phone = await freshDb();
  await receiveWithApproval(phone, (await startSend(computer, () => 0)).link);
  const api = transferRouter.createCaller({ db: phone, receivesCopy: true, isOwner: true } as never);
  assert.equal((await api.lastSync())?.paired, true);
  await api.forgetPairings();
  assert.equal((await api.lastSync())?.paired, false);
  const { link } = await startSend(computer, () => 0);
  assert.equal((await api.inspect({ link })).mode, "replace");
  assert.equal((await receiveWithApproval(phone, link)).mode, "replace");
  assert.equal((await api.lastSync())?.paired, true);
  await clearPairings(computer);
  // The computer lost the pairing: the phone is told how to pair again, and nothing changes.
  await assert.rejects(receiveCopy(phone, (await startSend(computer, () => 0)).link), /does not hold a pairing with this phone.*Forget computer/);
});

test("a caller without the session key cannot take or stop an allowed full copy", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const { key } = await ask(link, "replace");
  approve();

  assert.equal((await fetch(new URL(param(link, "from")))).status, 404);
  assert.equal((await post(link, "", "x")).status, 403);
  assert.equal((await pull(link, randomSecret())).status, 403);
  assert.equal((await pull(link, keyOf(link))).status, 403);
  // A message of another kind does not pass as the request for the copy.
  assert.equal((await post(link, "", await seal("{}", key, "cancel"))).status, 403);
  assert.equal(sendStatus()?.phase, "transfer");
  assert.equal(await getPairing(computer, "p-1"), undefined);

  const data = await pull(link, key);
  assert.equal(data.status, 200);
  const opened = JSON.parse(await unseal(await data.text(), key, "snapshot")) as { pairing: string };
  assert.equal(opened.pairing, await getPairing(computer, "p-1"));
  await until(() => sendStatus()?.phase === "apply");
});

/** Starts a merge upload on a raw connection: the headers and the first byte of a body that never ends. Resolves with what the computer answers. */
async function partialUpload(t: { after(fn: () => void): void }, link: string, proof?: string) {
  const { connect } = await import("node:net");
  const from = new URL(param(link, "from"));
  const socket = connect(Number(from.port), from.hostname);
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  let answer = "";
  socket.on("data", (chunk) => { answer += chunk; });
  const closed = new Promise<string>((resolve) => {
    socket.once("close", () => resolve(answer));
    setTimeout(() => resolve(answer), 5000).unref();
  });
  socket.write(`POST ${from.pathname}/merge HTTP/1.1\r\nHost: ${from.host}\r\n${proof ? `x-tracer-proof: ${proof}\r\n` : ""}Content-Length: 100000000\r\n\r\nx`);
  return { socket, closed };
}

test("a merge upload without the session key does not take or end the exchange", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const secret = randomSecret();
  await setPairing(computer, "p-1", secret);
  const { key } = await ask(link, "merge", { pairing: secret });
  approve();

  // The proof travels as a header value: plain characters and short.
  assert.match(await seal("{}", key, "merge-request"), /^[A-Za-z0-9_.-]{1,100}$/);
  // Refused before the body arrives: the answer comes and the connection closes while the upload has sent one byte.
  for (const proof of [undefined, await seal("{}", keyOf(link), "merge-request"), await seal("{}", key, "merge-up")]) {
    assert.match(await (await partialUpload(t, link, proof)).closed, /^HTTP\/1\.1 403 /);
  }
  assert.equal((await upload(link, await seal("{}", key, "merge-up"), randomSecret())).status, 403);
  assert.equal(sendStatus()?.phase, "transfer");

  const answer = await upload(link, await seal(JSON.stringify({ payload: await exportSyncPayload(await freshDb()) }), key, "merge-up"), key);
  assert.equal(answer.status, 200);
  await unseal(await answer.text(), key, "merge-down");
  await until(() => sendStatus()?.phase === "apply");
  assert.equal((await report(link, { phase: "done", result: { applied: 0, deleted: 0 } })).status, 200);
  assert.equal(sendStatus()?.phase, "done");
});

test("an upload of the phone that breaks off ends the sync as failed", async (t) => {
  t.after(stopSend);
  const computer = await seededDb();
  const { link } = await startSend(computer, () => 0);
  const secret = randomSecret();
  await setPairing(computer, "p-1", secret);
  const { key } = await ask(link, "merge", { pairing: secret });
  approve();

  const { socket } = await partialUpload(t, link, await seal("{}", key, "merge-request"));
  await new Promise((r) => setTimeout(r, 100));
  // One upload at a time.
  assert.equal((await upload(link, "x", key)).status, 409);
  socket.destroy();
  await until(() => sendStatus()?.phase === "failed");
  assert.equal(sendStatus()?.error?.side, "computer");
});

test("a short message over the size limit is refused and does not end an allowed sync", async (t) => {
  t.after(stopSend);
  const { link } = await startSend(await seededDb(), () => 0);
  const large = "x".repeat(8 * 1024 + 1);
  assert.equal((await post(link, "/request", large)).status, 413);
  assert.equal(sendStatus()?.phase, "waiting");
  assert.equal((await ask(link, "replace")).status, 200);
  approve();

  for (const route of ["/progress", "/cancel", ""]) assert.equal((await post(link, route, large)).status, 413, route);
  assert.equal(sendStatus()?.phase, "transfer");

  assert.equal((await pull(link)).status, 200);
  await until(() => sendStatus()?.phase === "apply");
  // The largest report the phone sends: 500 characters that do not compress.
  const error = Array.from({ length: 500 }, () => String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x5000))).join("");
  assert.equal((await report(link, { phase: "failed", bytes: { done: 1e9, total: 1e9 }, error })).status, 200);
  assert.equal(sendStatus()?.error?.message, error);
});

test("importSnapshot counts a change time far ahead of this clock as now", async () => {
  const snapshot = await exportSnapshot(await seededDb());
  const [ahead, near] = snapshot.rows;
  ahead.changed_at = Date.now() + 3_600_000;
  near.changed_at = Date.now() + 60_000;
  const target = await freshDb();
  await importSnapshot(target, snapshot);
  const stored = await target.select().from(syncRows).all();
  const timeOf = (row: typeof ahead) => stored.find((r) => r.tbl === row.tbl && r.rowKey === row.row_key)!.changedAt;
  assert.ok(timeOf(ahead) <= Date.now());
  assert.equal(timeOf(near), near.changed_at);
});

test("TRACER_SYNC accepts off, false and 0 in any case", async (t) => {
  t.after(() => { delete process.env.TRACER_SYNC; stopSend(); });
  const computer = await seededDb();
  const api = transferRouter.createCaller({ db: computer, activeStreams: new Set(), isOwner: true } as never);
  for (const value of ["OFF", "False", "0", " off "]) {
    process.env.TRACER_SYNC = value;
    assert.equal(await api.sendEnabled(), false, value);
    await assert.rejects(startSend(computer, () => 0), /TRACER_SYNC=off/, value);
  }
  process.env.TRACER_SYNC = "on";
  assert.equal(await api.sendEnabled(), true);
  assert.equal((await startSend(computer, () => 0)).session.phase, "waiting");
});

test("TRACER_SYNC=off refuses to show a code and opens no listener", async (t) => {
  t.after(() => { delete process.env.TRACER_SYNC; stopSend(); });
  const computer = await seededDb();
  const api = transferRouter.createCaller({ db: computer, activeStreams: new Set(), isOwner: true } as never);
  assert.equal(await api.sendEnabled(), true);
  process.env.TRACER_SYNC = "off";
  assert.equal(await api.sendEnabled(), false);
  await assert.rejects(startSend(computer, () => 0), /TRACER_SYNC=off/);
  await assert.rejects(api.send(), /TRACER_SYNC=off/);
  assert.equal(sendStatus(), null);
});

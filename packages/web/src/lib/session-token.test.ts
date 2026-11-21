import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { getSessionToken, isLocked, lockSession, startSession, subscribeLocked, tokenFromHash } from "./session-token.js";
import { serverFetch } from "./server-fetch.js";
import { FetchEventSource } from "./fetch-event-source.js";

function fakeBrowser(hash: string, stored: string | null, storageWorks = true) {
  const store = new Map<string, string>(stored ? [["tracer-session-token", stored]] : []);
  const replaced: string[] = [];
  const fail = () => { throw new Error("storage is off"); };
  Object.assign(globalThis, {
    window: {
      location: { hash, pathname: "/debug/abc", search: "?x=1", reload() {} },
      history: { state: null, replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
      addEventListener() {},
    },
    localStorage: storageWorks
      ? { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
      : { getItem: fail, setItem: fail },
  });
  return { store, replaced };
}

test("the fragment holds the secret", () => {
  assert.equal(tokenFromHash("#t=abc_-123"), "abc_-123");
  assert.equal(tokenFromHash("#x=1&t=abc"), "abc");
  assert.equal(tokenFromHash("#t="), null);
  assert.equal(tokenFromHash(""), null);
  assert.equal(tokenFromHash("#section"), null);
});

test("with no secret the app is locked", () => {
  fakeBrowser("", null);
  startSession();
  assert.equal(getSessionToken(), null);
  assert.equal(isLocked(), true);
});

test("a secret in the link is stored and removed from the address", () => {
  const { store, replaced } = fakeBrowser("#t=from-link", null);
  startSession();
  assert.equal(getSessionToken(), "from-link");
  assert.equal(store.get("tracer-session-token"), "from-link");
  assert.deepEqual(replaced, ["/debug/abc?x=1"]);
  assert.equal(isLocked(), false);
});

/** A server that accepts one secret; it records the secret of each call. */
function fakeServer(t: TestContext, valid: string) {
  const seen: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    seen.push(auth);
    return new Response("{}", { status: auth === `Bearer ${valid}` ? 200 : 401 });
  });
  return seen;
}

test("a secret in the link replaces the stored one after the server accepts it", async (t) => {
  const { store, replaced } = fakeBrowser("#t=from-link", "old");
  startSession();
  assert.equal(getSessionToken(), "from-link");
  assert.equal(store.get("tracer-session-token"), "old");
  assert.deepEqual(replaced, ["/debug/abc?x=1"]);
  fakeServer(t, "from-link");
  assert.equal((await serverFetch("/api/trpc/x")).status, 200);
  assert.equal(store.get("tracer-session-token"), "from-link");
  assert.equal(isLocked(), false);
});

test("a refused secret in the link leaves the stored one in use", async (t) => {
  const { store } = fakeBrowser("#t=crafted", "old");
  startSession();
  const seen = fakeServer(t, "old");
  const responses = await Promise.all([serverFetch("/api/trpc/x"), serverFetch("/api/trpc/y")]);
  assert.deepEqual(responses.map((res) => res.status), [200, 200]);
  assert.deepEqual(seen, ["Bearer crafted", "Bearer crafted", "Bearer old", "Bearer old"]);
  assert.equal(getSessionToken(), "old");
  assert.equal(store.get("tracer-session-token"), "old");
  assert.equal(isLocked(), false);
});

test("a refused secret in the link locks the app when the stored one is refused too", async (t) => {
  const { store } = fakeBrowser("#t=crafted", "old");
  startSession();
  fakeServer(t, "other");
  assert.equal((await serverFetch("/api/trpc/x")).status, 401);
  assert.equal(store.get("tracer-session-token"), "old");
  assert.equal(isLocked(), true);
});

test("a stored secret is used on a later visit", () => {
  const { replaced } = fakeBrowser("", "stored");
  startSession();
  assert.equal(getSessionToken(), "stored");
  assert.deepEqual(replaced, []);
  assert.equal(isLocked(), false);
});

test("a secret in the link works when storage throws", () => {
  fakeBrowser("#t=from-link", null, false);
  startSession();
  assert.equal(getSessionToken(), "from-link");
  assert.equal(isLocked(), false);
});

test("server calls carry the secret, and a 401 locks the app", async (t) => {
  fakeBrowser("#t=s3cret", null);
  startSession();
  const seen: (string | null)[] = [];
  let status = 200;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization"));
    return new Response("{}", { status });
  });
  let notified = 0;
  const unsubscribe = subscribeLocked(() => notified++);
  await serverFetch("/api/trpc/x", { headers: { "content-type": "application/json" } });
  assert.deepEqual(seen, ["Bearer s3cret"]);
  assert.equal(isLocked(), false);
  status = 401;
  await serverFetch("/api/trpc/x");
  assert.equal(isLocked(), true);
  assert.equal(notified, 1);
  lockSession();
  assert.equal(notified, 1);
  unsubscribe();
});

test("the event source sends the secret, delivers events and reports the end of the stream as closed", async (t) => {
  fakeBrowser("#t=s3cret", null);
  startSession();
  let auth: string | null = null;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    auth = new Headers(init?.headers).get("authorization");
    return new Response("event: connected\ndata: {}\n\ndata: {\"a\":1}\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const source = new FetchEventSource("/api/trpc/sessions.onChange");
  const events: string[] = [];
  source.addEventListener("connected", (e) => events.push(`connected ${(e as MessageEvent).data}`));
  source.addEventListener("message", (e) => events.push(`message ${(e as MessageEvent).data}`));
  const stateAtError = await new Promise<number>((resolve) => source.addEventListener("error", () => resolve(source.readyState)));
  assert.equal(auth, "Bearer s3cret");
  assert.deepEqual(events, ["connected {}", "message {\"a\":1}"]);
  assert.equal(stateAtError, source.CLOSED);
});

test("the event source reports a refused request as closed, and stays silent after close()", async (t) => {
  fakeBrowser("#t=s3cret", null);
  startSession();
  t.mock.method(globalThis, "fetch", async () => new Response("Unauthorized", { status: 401 }));
  const refused = new FetchEventSource("/api/trpc/sessions.onChange");
  assert.equal(await new Promise<number>((resolve) => refused.addEventListener("error", () => resolve(refused.readyState))), refused.CLOSED);

  const closed = new FetchEventSource("/api/trpc/sessions.onChange");
  let errors = 0;
  closed.addEventListener("error", () => errors++);
  closed.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors, 0);
});

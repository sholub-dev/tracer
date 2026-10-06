import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

const realFetch = globalThis.fetch;
const realDelays = CONFIG.fetchRetryDelaysMs;
afterEach(() => {
  globalThis.fetch = realFetch;
  (CONFIG as unknown as { fetchRetryDelaysMs: readonly number[] }).fetchRetryDelaysMs = realDelays;
});

function script(...steps: Array<Response | Error>) {
  (CONFIG as unknown as { fetchRetryDelaysMs: number[] }).fetchRetryDelaysMs = [1, 1];
  let calls = 0;
  globalThis.fetch = (async () => {
    const step = steps[Math.min(calls++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return () => calls;
}

test("repeats after a network error and returns the later response", async () => {
  const calls = script(new TypeError("fetch failed"), new Response("ok"));
  const res = await fetchWithRetry("https://x.test", {}, { timeoutMs: 1000 });
  assert.equal(await res.text(), "ok");
  assert.equal(calls(), 2);
});

test("returns the last response after the delays run out", async () => {
  const calls = script(new Response("", { status: 503 }));
  const res = await fetchWithRetry("https://x.test");
  assert.equal(res.status, 503);
  assert.equal(calls(), 3);
});

test("does not repeat a 400 response", async () => {
  const calls = script(new Response("", { status: 400 }));
  await fetchWithRetry("https://x.test");
  assert.equal(calls(), 1);
});

test("throws the last error", async () => {
  const calls = script(new TypeError("fetch failed"));
  await assert.rejects(fetchWithRetry("https://x.test"), /fetch failed/);
  assert.equal(calls(), 3);
});

test("retry false makes one attempt", async () => {
  const calls = script(new TypeError("fetch failed"));
  await assert.rejects(fetchWithRetry("https://x.test", {}, { retry: false }));
  assert.equal(calls(), 1);
});

test("a caller abort stops during the wait", async () => {
  script(new Response("", { status: 503 }));
  (CONFIG as unknown as { fetchRetryDelaysMs: number[] }).fetchRetryDelaysMs = [5_000];
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  const started = Date.now();
  await assert.rejects(fetchWithRetry("https://x.test", { signal: ctrl.signal }));
  assert.ok(Date.now() - started < 1000);
});

test("times out a request that ignores its signal, then repeats it", async () => {
  (CONFIG as unknown as { fetchRetryDelaysMs: number[] }).fetchRetryDelaysMs = [1];
  let calls = 0;
  globalThis.fetch = (() => { calls++; return new Promise<Response>(() => {}); }) as typeof fetch;
  await assert.rejects(fetchWithRetry("https://x.test", {}, { timeoutMs: 20 }), { name: "TimeoutError" });
  assert.equal(calls, 2);
});

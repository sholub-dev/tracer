import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetryableFailures } from "./resolve.js";

const failWith = (err: unknown) => withRetryableFailures((async () => { throw err; }) as typeof fetch)("http://x");

test("a bare WebKit network error becomes a TypeError 'fetch failed' with a cause", async () => {
  const original = new TypeError("Load failed");
  await assert.rejects(failWith(original), (e: Error) => e instanceof TypeError && e.message === "fetch failed" && e.cause === original);
});

test("aborts and non-transient errors pass through unchanged", async () => {
  const abort = new DOMException("aborted", "AbortError");
  await assert.rejects(failWith(abort), (e) => e === abort);
  const other = new Error("bad request");
  await assert.rejects(failWith(other), (e) => e === other);
});

test("a successful response passes through", async () => {
  const res = new Response("ok");
  assert.equal(await withRetryableFailures((async () => res) as typeof fetch)("http://x"), res);
});

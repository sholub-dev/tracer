import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError, RetryError } from "ai";
import { isTransientError } from "./transient.js";

test("network failures, timeouts and server errors are transient", () => {
  assert.equal(isTransientError(new TypeError("Load failed")), true);
  assert.equal(isTransientError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })), true);
  assert.equal(isTransientError(Object.assign(new Error("slow"), { name: "TimeoutError" })), true);
  assert.equal(isTransientError({ statusCode: 429 }), true);
  assert.equal(isTransientError({ statusCode: 503 }), true);
  assert.equal(isTransientError({ type: "overloaded_error", message: "Overloaded" }), true);
  assert.equal(isTransientError(new Error("No data from the model")), true);
  assert.equal(isTransientError(new RetryError({ message: "Failed after 3 attempts. Last error: Internal Server Error", reason: "maxRetriesExceeded", errors: [] })), true);
});

test("an error of an unknown shape is transient", () => {
  assert.equal(isTransientError(new Error("The model stream failed")), true);
  assert.equal(isTransientError(new TypeError("Software caused connection abort")), true);
  assert.equal(isTransientError(new Error("boom")), true);
  assert.equal(isTransientError("cancelled"), true);
});

test("aborts and client errors are not transient", () => {
  assert.equal(isTransientError(Object.assign(new Error("stop"), { name: "AbortError" })), false);
  assert.equal(isTransientError({ statusCode: 400 }), false);
  assert.equal(isTransientError(new APICallError({ message: "bad key", url: "u", requestBodyValues: {}, statusCode: 401 })), false);
  assert.equal(isTransientError({ type: "invalid_request_error", message: "bad input" }), false);
  const notRetryable = new APICallError({ message: "bad key", url: "u", requestBodyValues: {}, statusCode: 401 });
  assert.equal(isTransientError(new RetryError({ message: "Failed", reason: "errorNotRetryable", errors: [notRetryable] })), false);
});

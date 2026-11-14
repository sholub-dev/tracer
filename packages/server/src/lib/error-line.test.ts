import { test } from "node:test";
import assert from "node:assert/strict";
import { errorLine } from "./error-line.js";

test("an error is logged as its message and status, without its body fields", () => {
  const err = Object.assign(new Error("Overloaded"), { statusCode: 529, requestBodyValues: { messages: ["secret prompt"] }, responseBody: "secret reply" });
  assert.equal(errorLine(err), "Overloaded (status 529)");
  const call = Object.assign(new Error("fetch failed"), { url: "https://api.example/v1", requestBodyValues: { messages: ["secret prompt"] } });
  assert.equal(errorLine(call), "fetch failed");
  assert.equal(errorLine("text"), "text");
});

test("an error of the app keeps its stack", () => {
  assert.match(errorLine(new Error("boom")), /^Error: boom\n\s+at /);
  assert.match(errorLine(new TypeError("x is not a function")), /^TypeError: x is not a function\n\s+at /);
});

test("a value that is not an Error is logged as its message or its fields, without body fields", () => {
  assert.equal(errorLine({ message: "rate limited", status: 429, responseBody: "secret reply" }), "rate limited (status 429)");
  assert.equal(errorLine({ code: "E_FAIL", detail: { id: 1 }, body: "secret", requestBodyValues: { a: 1 }, responseHeaders: { x: "y" }, data: "secret" }), '{"code":"E_FAIL","detail":{"id":1}}');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.equal(errorLine(loop), "[object Object]");
  assert.equal(errorLine({ items: "x".repeat(500) }).length, 301);
  assert.equal(errorLine(null), "null");
  assert.equal(errorLine(undefined), "undefined");
});

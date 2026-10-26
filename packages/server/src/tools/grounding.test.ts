import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedNumbers, groundingProblems } from "./grounding.js";

const results = new Map([["requests by ip", "ip,Requests\na,1241\ntotal,1507"]]);

test("a window length is not a claimed number", () => {
  assert.deepEqual(claimedNumbers("Over the 24-hour window and the last 30 minutes, 512 calls failed.").map((n) => n.text), ["512"]);
});

test("a share, a difference or a change worked out from grounded numbers passes; a made-up one does not", () => {
  assert.deepEqual(groundingProblems("s", "One IP sent 1,241 of 1,507 requests (82.35%), 266 from others.", ["Requests by IP"], results), []);
  assert.equal(groundingProblems("s", "One IP sent 1,241 of 1,507 requests (71.4%).", ["Requests by IP"], results).length, 1);
});

test("short window forms are not claimed numbers, and answer numbers can back a worked-out change", () => {
  assert.deepEqual(claimedNumbers("Errors peaked at 340 in the last 24h and over the 30-min window.").map((n) => n.text), ["340"]);
  assert.deepEqual(groundingProblems("s", "Errors rose 77% this hour.", ["Requests by IP"], results, [1241, 700]), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedNumbers, groundingProblems, queryResults } from "./grounding.js";
import { toolModelOutput } from "./provider-tool-helpers.js";

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

test("a failed query is not a source: in the messages, as a masked original and as a read of the same step", () => {
  const failed = toolModelOutput({ error: "bad query" });
  const ok = toolModelOutput({ analysis: "a,1" });
  const call = (id: string, title: string) => ({ type: "tool-call" as const, toolCallId: id, toolName: "execute_nrql", input: { title } });
  const result = (id: string, output: unknown) => ({ type: "tool-result" as const, toolCallId: id, toolName: "execute_nrql", output });
  const messages = [
    { role: "assistant", content: [call("1", "Failed"), call("2", "Masked"), call("3", "Good")] },
    { role: "tool", content: [result("1", failed), result("2", { type: "text", value: "stub" }), result("3", ok)] },
  ] as never;
  const reads = [{ toolName: "execute_nrql", input: { title: "Same step" }, text: failed.value }];
  assert.deepEqual([...queryResults(messages, new Map([["2", failed.value]]), reads).keys()], ["good"]);
});

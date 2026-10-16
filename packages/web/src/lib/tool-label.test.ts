import { test } from "node:test";
import assert from "node:assert/strict";
import { smallToolLabel } from "./tool-label";

const spec = { done: "Finding reported", errorLabel: "Finding not recorded" };

test("a string or number output does not throw", () => {
  assert.equal(smallToolLabel({ type: "tool-report_finding", output: "ok" }, spec), "Finding reported");
  assert.equal(smallToolLabel({ type: "tool-report_finding", output: 5 }, spec), "Finding reported");
});

test("object outputs keep their wording", () => {
  assert.equal(smallToolLabel({ type: "t", output: { error: "bad" } }, spec), "Finding not recorded: bad");
  assert.equal(smallToolLabel({ type: "t", output: { dueAt: "10:00" }, input: { note: "n" } }, spec), "Finding reported for 10:00: n");
});

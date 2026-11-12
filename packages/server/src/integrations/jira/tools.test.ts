import { test } from "node:test";
import assert from "node:assert/strict";
import { ISSUE_KEY } from "./tools.js";

test("issue keys accept project keys and reject path tricks", () => {
  for (const ok of ["PROJ-123", "A1_B-7", "proj-1"]) assert.ok(ISSUE_KEY.test(ok), ok);
  for (const bad of ["..", "../x", "PROJ-1/comment", "PROJ-1\n", "PROJ-", "PROJ-1?x=1"]) assert.ok(!ISSUE_KEY.test(bad), bad);
});

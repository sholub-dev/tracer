import { test } from "node:test";
import assert from "node:assert/strict";
import { ISSUE_KEY, issueText } from "./tools.js";

test("issue keys accept project keys and reject path tricks", () => {
  for (const ok of ["PROJ-123", "A1_B-7", "proj-1"]) assert.ok(ISSUE_KEY.test(ok), ok);
  for (const bad of ["..", "../x", "PROJ-1/comment", "PROJ-1\n", "PROJ-", "PROJ-1?x=1"]) assert.ok(!ISSUE_KEY.test(bad), bad);
});

test("the model text omits empty fields and cuts the description before the newest comments", () => {
  const issue = {
    key: "P-1", summary: "s", description: "d".repeat(40_000), status: "Open", issueType: null, priority: null, assignee: null, reporter: null,
    labels: [], components: [], fixVersions: [], created: null, updated: null, dueDate: null, resolution: null,
    comments: [{ id: "1", author: "a", body: "old", created: "t1" }, { id: "2", author: "b", body: "new", created: "t2" }],
  };
  const text = issueText(issue);
  assert.ok(text.length < 31_000);
  assert.ok(!text.includes("issueType"));
  assert.match(text, /Description cut at/);
  assert.match(text, /Showing the newest 0 of 2 comments/);
  const short = issueText({ ...issue, description: "short" });
  assert.ok(short.indexOf("new") < short.indexOf("old"));
});

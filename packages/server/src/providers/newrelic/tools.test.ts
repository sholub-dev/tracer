import { test } from "node:test";
import assert from "node:assert/strict";
import { NewRelicProvider } from "./newrelic.provider.js";
import { buildNewRelicIssueTools, createNewRelicDirectTools } from "./tools.js";

const stub = (over: Record<string, unknown> = {}) => ({
  ackIssue: async () => ({ error: "ack failed" }),
  resolveIssue: async () => ({ error: "close failed" }),
  aiIssues: async () => [
    { issueId: "i1", state: "ACTIVATED", title: ["T1"], conditionName: ["C1"], incidentIds: ["n1"] },
    { issueId: "i2", state: "CLOSED", title: null, conditionName: null, incidentIds: null },
  ],
  ...over,
}) as unknown as NewRelicProvider;

test("chat tools include the issue tools", () => {
  const { tools } = createNewRelicDirectTools(stub());
  for (const name of ["execute_nrql", "list_nr_issues", "ack_nr_issue", "close_nr_issue"]) assert.ok(name in tools, name);
});

test("ack and close return the provider result unchanged", async () => {
  const tools = buildNewRelicIssueTools(stub()) as Record<string, any>;
  assert.deepEqual(await tools.ack_nr_issue.execute({ issueId: "i1" }, {}), { error: "ack failed" });
  assert.deepEqual(await tools.close_nr_issue.execute({ issueId: "i1" }, {}), { error: "close failed" });
  const ok = buildNewRelicIssueTools(stub({ ackIssue: async () => ({ ok: true }) })) as Record<string, any>;
  assert.deepEqual(await ok.ack_nr_issue.execute({ issueId: "i1" }, {}), { ok: true });
});

test("list_nr_issues filters by state and returns an error instead of throwing", async () => {
  const tools = buildNewRelicIssueTools(stub()) as Record<string, any>;
  const out = await tools.list_nr_issues.execute({ states: ["ACTIVATED"] }, {});
  assert.deepEqual(out.issues, [{ issueId: "i1", state: "ACTIVATED", title: "T1", conditionName: "C1", incidentIds: ["n1"] }]);
  const failing = buildNewRelicIssueTools(stub({ aiIssues: async () => { throw new Error("boom"); } })) as Record<string, any>;
  assert.deepEqual(await failing.list_nr_issues.execute({}, {}), { error: "boom" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { NewRelicProvider } from "./newrelic.provider.js";
import { MAX_SAVED_ROWS } from "../../lib/messages-codec.js";
import { buildNewRelicIssueTools, createNewRelicDirectTools } from "./tools.js";

const stub = (over: Record<string, unknown> = {}) => ({
  ackIssue: async () => ({ error: "ack failed" }),
  resolveIssue: async () => ({ error: "close failed" }),
  aiIssuesPage: async () => ({
    issues: [
      { issueId: "i1", state: "ACTIVATED", title: ["T1"], conditionName: ["C1"], incidentIds: ["n1"] },
      { issueId: "i2", state: "CLOSED", title: null, conditionName: null, incidentIds: null },
    ],
    truncated: false,
  }),
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
  const failing = buildNewRelicIssueTools(stub({ aiIssuesPage: async () => { throw new Error("boom"); } })) as Record<string, any>;
  assert.deepEqual(await failing.list_nr_issues.execute({}, {}), { error: "boom" });
});

test("list_nr_issues reports the window and truncation", async () => {
  const tools = buildNewRelicIssueTools(stub({ aiIssuesPage: async () => ({ issues: [], truncated: true }) })) as Record<string, any>;
  assert.deepEqual(await tools.list_nr_issues.execute({ sinceHours: 24 }, {}), { issues: [], sinceHours: 24, truncated: true });
  assert.equal((await tools.list_nr_issues.execute({}, {})).sinceHours, 6);
});

test("execute_nrql returns capped table rows once, without a separate progress write", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ host: `h${i}`, n: i }));
  const provider = stub({ executeRawQuery: async () => rows });
  const { tools } = createNewRelicDirectTools(provider) as { tools: Record<string, any> };
  const out = await tools.execute_nrql.execute({ query: "SELECT host, n FROM Log" }, { toolCallId: "c" });
  assert.equal(out.parts.length, 1);
  assert.equal(out.parts[0].results.length, MAX_SAVED_ROWS);
  assert.equal(out.parts[0].totalRows, 300);
});

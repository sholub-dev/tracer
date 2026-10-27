import { test } from "node:test";
import assert from "node:assert/strict";
import { NewRelicProvider } from "./newrelic.provider.js";
import { MAX_SAVED_ROWS } from "../../lib/messages-codec.js";
import { buildNewRelicIssueTools, createNewRelicDirectTools } from "./tools.js";
import { withFixHint } from "./nrql-errors.js";

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
  assert.deepEqual(out.issues.map((i: { issueId: string }) => i.issueId), ["i1", "i2"]);
  assert.deepEqual(out.issues[0], { issueId: "i1", state: "ACTIVATED", title: "T1", conditionName: "C1", incidentIds: ["n1"] });
  const failing = buildNewRelicIssueTools(stub({ aiIssuesPage: async () => { throw new Error("boom"); } })) as Record<string, any>;
  assert.deepEqual(await failing.list_nr_issues.execute({}, {}), { error: "boom" });
});

test("list_nr_issues reports the window and truncation", async () => {
  const tools = buildNewRelicIssueTools(stub({ aiIssuesPage: async () => ({ issues: [], truncated: true }) })) as Record<string, any>;
  assert.deepEqual(await tools.list_nr_issues.execute({ sinceHours: 24 }, {}), { issues: [], sinceHours: 24, truncated: true });
  assert.equal((await tools.list_nr_issues.execute({}, {})).sinceHours, 6);
});

test("list_nr_issues passes states to the filter and widens the window for issueIds", async () => {
  let seen: { filter?: unknown; start?: number; end?: number } = {};
  const tools = buildNewRelicIssueTools(stub({
    aiIssuesPage: async (filter: unknown, start: number, end: number) => { seen = { filter, start, end }; return { issues: [], truncated: false }; },
  })) as Record<string, any>;
  await tools.list_nr_issues.execute({ states: ["CLOSED"] }, {});
  assert.deepEqual(seen.filter, { states: ["CLOSED"] });
  const out = await tools.list_nr_issues.execute({ issueIds: ["i9"] }, {});
  assert.equal(out.sinceHours, 720);
  assert.deepEqual(seen.filter, { ids: ["i9"] });
});

test("list_nr_issues returns times, priority, entities and every distinct title", async () => {
  const tools = buildNewRelicIssueTools(stub({
    aiIssuesPage: async () => ({
      issues: [{ issueId: "i1", state: "CLOSED", title: ["A", "B", "A"], conditionName: ["C"], incidentIds: null, priority: "CRITICAL", entityNames: ["svc"], createdAt: 1_700_000_000_000, activatedAt: null, closedAt: 1_700_000_600_000, acknowledgedAt: null, acknowledgedBy: null }],
      truncated: false,
    }),
  })) as Record<string, any>;
  const [issue] = (await tools.list_nr_issues.execute({}, {})).issues;
  assert.deepEqual(issue.title, ["A", "B"]);
  assert.equal(issue.conditionName, "C");
  assert.equal(issue.priority, "CRITICAL");
  assert.deepEqual(issue.entityNames, ["svc"]);
  assert.match(issue.createdAt, /^2023-11-1[45] \d\d:\d\d:\d\d/);
  assert.ok(!("activatedAt" in issue) && !("acknowledgedBy" in issue));
});

const nrql = (over: Record<string, unknown>) => stub({
  executeNrql: async () => ({ rows: [{ n: 1 }], futureRemoved: 0, window: null, messages: [], ...over }),
});
const runNrql = async (provider: NewRelicProvider, query: string) => {
  const { tools } = createNewRelicDirectTools(provider) as { tools: Record<string, any> };
  return (await tools.execute_nrql.execute({ query }, { toolCallId: "c" })).analysis as string;
};

test("execute_nrql appends the window and New Relic messages", async () => {
  const text = await runNrql(nrql({ window: { begin: 1_700_000_000_000, end: 1_700_003_600_000 }, messages: ["Results are sampled"] }), "SELECT count(*) AS 'n' FROM Log SINCE 1 hour ago");
  assert.match(text, /\nWindow: .+ to .+/);
  assert.match(text, /\nNew Relic: Results are sampled$/);
});

test("execute_nrql notes a missing SINCE when no window is known", async () => {
  assert.match(await runNrql(nrql({}), "SELECT count(*) AS 'n' FROM Log"), /No SINCE: NRQL used the last 60 minutes\.$/);
  assert.doesNotMatch(await runNrql(nrql({}), "SELECT count(*) FROM Log SINCE 1 day ago"), /No SINCE/);
});

test("execute_nrql skips the SINCE note for SHOW and keyset queries and ignores SINCE inside strings", async () => {
  assert.doesNotMatch(await runNrql(nrql({}), "SHOW EVENT TYPES"), /No SINCE/);
  assert.doesNotMatch(await runNrql(nrql({}), "SELECT keyset() FROM Log"), /No SINCE/);
  assert.match(await runNrql(nrql({}), "SELECT count(*) FROM Log WHERE message = 'since SINCE 1 day ago'"), /No SINCE/);
});

test("execute_nrql says when future buckets were all removed", async () => {
  const text = await runNrql(nrql({ rows: [], futureRemoved: 5 }), "SELECT count(*) FROM Log SINCE 1 day ago");
  assert.match(text, /^No results: all 5 rows start after now/);
});

test("execute_nrql marks a bucket that ends after now as partial", async () => {
  const now = Math.floor(Date.now() / 1000);
  const rows = [
    { beginTimeSeconds: now - 600, endTimeSeconds: now - 300, n: 1 },
    { beginTimeSeconds: now - 300, endTimeSeconds: now + 300, n: 2 },
  ];
  const lines = (await runNrql(nrql({ rows }), "SELECT count(*) FROM Log SINCE 10 minutes ago TIMESERIES 5 minutes")).split("\n");
  const partial = lines.findIndex((l) => /\(partial\),2$/.test(l));
  assert.ok(partial > 1);
  assert.doesNotMatch(lines[partial - 1], /partial/);
});

test("execute_nrql returns capped table rows once, without a separate progress write", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ host: `h${i}`, n: i }));
  const provider = stub({ executeNrql: async () => ({ rows, futureRemoved: 0, window: null, messages: [] }) });
  const { tools } = createNewRelicDirectTools(provider) as { tools: Record<string, any> };
  const out = await tools.execute_nrql.execute({ query: "SELECT host, n FROM Log" }, { toolCallId: "c" });
  assert.equal(out.parts.length, 1);
  assert.equal(out.parts[0].results.length, MAX_SAVED_ROWS);
  assert.equal(out.parts[0].totalRows, 300);
});

const nrqlTool = (executeNrql: (q: string) => Promise<unknown>) =>
  (createNewRelicDirectTools({ executeNrql } as unknown as NewRelicProvider).tools as Record<string, any>).execute_nrql;
const okRows = async () => ({ rows: [{ count: 1 }], futureRemoved: 0, window: null, messages: [] });
const failWith = (m: string) => async () => { throw new Error(m); };

test("execute_nrql appends a fix after the original error", async () => {
  const cases: [string, string, string][] = [
    ["NerdGraph error: NRQL Syntax Error: Error at line 1 position 190, unexpected 'DESC'", "SELECT count(*) FROM T FACET a ORDER BY count(*) DESC", "without ASC or DESC"],
    ["NerdGraph error: NRQL Syntax Error: Error at line 1 position 90, unexpected 'ASC'", "SELECT count(*) FROM T FACET a ORDER BY count(*) ASC", "LIMIT MAX"],
    ["NerdGraph error: Unknown function percentage()", "SELECT max(percentage(count(*), WHERE error IS TRUE)) FROM T", "cannot be nested"],
    ["NerdGraph error: TIMESERIES supports a maximum of 366 buckets. Query has 1440.", "SELECT count(*) FROM T SINCE '2026-10-19 00:00:00' UNTIL '2026-10-20 00:00:00' TIMESERIES 1 minute", "at least 5 minutes"],
    ["NerdGraph error: TIMESERIES supports a maximum of 366 buckets. Query has 900.", "SELECT count(*) FROM T SINCE 7 days ago TIMESERIES 10 minutes", "at least 30 minutes"],
    ["NerdGraph error: TIMESERIES supports a maximum of 366 buckets. Query has 900.", "SELECT count(*) FROM T TIMESERIES 10 minutes", "366 or less"],
    ["NerdGraph error: NRQL Syntax Error: Error at line 1 position 8, unexpected 'count(*), count(DISTINCT `a`'", "SELECT count(*), count(DISTINCT `a`) FROM T", "uniqueCount(x)"],
  ];
  for (const [msg, query, hint] of cases) {
    const out = await nrqlTool(failWith(msg)).execute({ query }, {});
    assert.ok(out.error.startsWith(`${msg}\nFix: `), out.error);
    assert.ok(out.error.includes(hint), out.error);
  }
});

test("execute_nrql adds no fix for unrelated errors or flat Unknown function", async () => {
  assert.equal((await nrqlTool(failWith("NerdGraph error: There was an NRDB error")).execute({ query: "SELECT 1 FROM T" }, {})).error, "NerdGraph error: There was an NRDB error");
  const flat = "NerdGraph error: Unknown function apdex()";
  assert.equal((await nrqlTool(failWith(flat)).execute({ query: "SELECT apdex(duration, t: 0.5) FROM T" }, {})).error, flat);
  assert.equal((await nrqlTool(failWith(flat)).execute({ query: "SELECT percentage(count(*), WHERE a = 'max(apdex(x))') FROM T" }, {})).error, flat);
});

test("execute_nrql notes a repeated query on the second identical run only", async () => {
  const note = "You ran this exact query earlier in this reply";
  const run = nrqlTool(okRows);
  assert.ok(!(await run.execute({ query: "SELECT count(*) FROM T SINCE 1 hour ago" }, {})).analysis.includes(note));
  assert.ok((await run.execute({ query: " SELECT count(*)  FROM T\nSINCE 1 hour ago " }, {})).analysis.includes(note));
  assert.ok(!(await nrqlTool(okRows).execute({ query: "SELECT count(*) FROM T SINCE 1 hour ago" }, {})).analysis.includes(note));
});

test("execute_nrql does not count a failed query as an earlier run", async () => {
  let fail = true;
  const run = nrqlTool(async () => { if (fail) throw new Error("boom"); return okRows(); });
  await run.execute({ query: "SELECT 1 FROM T" }, {});
  fail = false;
  assert.ok(!(await run.execute({ query: "SELECT 1 FROM T" }, {})).analysis.includes("earlier in this reply"));
});

test("a plain attribute next to aggregates gets the FACET hint", () => {
  const message = "NerdGraph error: Value must be constant in its context: Id{name='error.class', isQuoted=true}";
  assert.match(withFixHint(message, "SELECT count(*), `error.class` FROM TransactionError FACET `error.class`"), /\nFix: .*Move error\.class to FACET and select only aggregates\.$/);
});

test("a one-hour bucket hint reads in the singular", () => {
  const message = "TIMESERIES supports a maximum of 366 buckets. Query has 1440.";
  assert.match(withFixHint(message, "SELECT count(*) FROM Log SINCE 14 days ago TIMESERIES 1 minute"), /at least 1 hour for this window\.$/);
});

test("the model reads issues as a table with open issues first, under the result cap", async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ issueId: `c${i}`, state: "CLOSED", title: ["x".repeat(200)], conditionName: ["C"], incidentIds: [], activatedAt: i }));
  const issues = [...many, { issueId: "open1", state: "ACTIVATED", title: ["Open"], conditionName: ["C"], incidentIds: [], activatedAt: 1 }];
  const tools = buildNewRelicIssueTools(stub({ aiIssuesPage: async () => ({ issues, truncated: true }) })) as Record<string, any>;
  const out = await tools.list_nr_issues.execute({}, {});
  assert.equal(out.issues[0].issueId, "open1");
  assert.equal(out.issues.length, 401);
  const text: string = tools.list_nr_issues.toModelOutput({ output: out }).value;
  assert.match(text, /^<tool_result>\nissueId,state,/);
  assert.match(text, /\nopen1,ACTIVATED,Open,/);
  assert.match(text, /Showing \d+ of 401 rows: the rest do not fit the 30000-character result cap/);
  assert.match(text, /Covers the last 6 hours\. Open issues first, newest first\.\nMore issues exist than were read/);
  assert.ok(text.length < 31_000);
  assert.equal(tools.list_nr_issues.toModelOutput({ output: { error: "boom" } }).value, "Error: boom");
});

const REAL = "SELECT count(*) FROM Span WHERE appName = 'PROD-SVC-CREDIT-CARD-ACCOUNT' AND category = 'http' SINCE '2026-10-19 17:10:00' UNTIL '2026-10-19 17:35:00' FACET `transaction.name` LIMIT 10";
const probing = (probe: () => Promise<unknown>) => {
  const sent: string[] = [];
  const tool = nrqlTool(async (q) => {
    sent.push(q);
    return sent.length === 1 ? { rows: [], futureRemoved: 0, window: null, messages: [] } : probe();
  });
  return { sent, run: async (q: string) => (await tool.execute({ query: q }, { toolCallId: "c" })).analysis as string };
};
const countRows = (n: number) => async () => ({ rows: [{ count: n }], futureRemoved: 0, window: null, messages: [] });

test("execute_nrql explains an empty FACET result when rows match without the attribute", async () => {
  const { sent, run } = probing(countRows(27295));
  const text = await run(REAL);
  assert.match(text, /No results, but 27295 rows match the FROM and WHERE clauses in this window: none of them has transaction\.name\. FACET on an attribute the rows lack returns nothing; check the names with keyset\(\)\./);
  assert.equal(sent.length, 2);
  assert.equal(sent[1], "SELECT count(*) FROM Span WHERE appName = 'PROD-SVC-CREDIT-CARD-ACCOUNT' AND category = 'http' SINCE '2026-10-19 17:10:00' UNTIL '2026-10-19 17:35:00' WITH TIMEZONE '" + sent[0].match(/TIMEZONE '(.+)'$/)![1] + "'");
});

test("execute_nrql says when no row matches an empty FACET query", async () => {
  assert.match(await probing(countRows(0)).run(REAL.replace("count(*)", "count(*) AS 'n'")), /\nNo row matches the FROM and WHERE clauses in this window\.$/);
});

test("execute_nrql probe drops TIMESERIES, ORDER BY and COMPARE WITH and keeps the rest", async () => {
  const { sent, run } = probing(countRows(1));
  await run("SELECT average(duration) FROM Span WHERE name = 'a' SINCE 1 hour ago UNTIL 5 minutes ago FACET host ORDER BY host COMPARE WITH 1 day ago TIMESERIES 5 minutes LIMIT 5 WITH TIMEZONE 'UTC'");
  assert.equal(sent[1], "SELECT count(*) FROM Span WHERE name = 'a' SINCE 1 hour ago UNTIL 5 minutes ago WITH TIMEZONE 'UTC'");
});

test("execute_nrql probe keeps a WHERE after FACET and drops a SELECT after FROM", async () => {
  const { sent, run } = probing(countRows(1));
  const text = await run("FROM Span SELECT count(*) FACET host WHERE name = 'a' SINCE 1 hour ago WITH TIMEZONE 'UTC'");
  assert.equal(sent[1], "SELECT count(*) FROM Span WHERE name = 'a' SINCE 1 hour ago WITH TIMEZONE 'UTC'");
  assert.match(text, /none of them has host\./);
});

test("execute_nrql runs no probe for an empty result without FACET or with FACET only inside a string", async () => {
  const plain = probing(countRows(5));
  assert.doesNotMatch(await plain.run("SELECT count(*) FROM Log SINCE 1 hour ago"), /No results, but|No row matches/);
  assert.equal(plain.sent.length, 1);
  const quoted = probing(countRows(5));
  await quoted.run("SELECT count(*) FROM Log WHERE message = 'x FACET y LIMIT 3' SINCE 1 hour ago");
  assert.equal(quoted.sent.length, 1);
});

test("execute_nrql adds no note when the probe fails", async () => {
  const text = await probing(failWith("boom")).run(REAL);
  assert.doesNotMatch(text, /No results, but|No row matches|boom/);
});

test("execute_nrql keeps the probe out of the query parts", async () => {
  const { sent, run } = probing(countRows(3));
  await run(REAL);
  assert.equal(sent.length, 2);
  const tool = nrqlTool(async () => ({ rows: [], futureRemoved: 0, window: null, messages: [] }));
  assert.equal((await tool.execute({ query: "SELECT count(*) FROM Log SINCE 1 hour ago" }, { toolCallId: "c" })).parts.length, 1);
});

test("execute_nrql notes aggregates without an AS alias and stays quiet when aliased", async () => {
  const note = /Note: no AS aliases\. A person reads these column names; alias every value in the next queries\./;
  assert.match(await runNrql(nrql({}), "SELECT count(*) FROM Log SINCE 1 day ago"), note);
  assert.match(await runNrql(nrql({}), "SELECT average(duration), percentile(duration, 95) FROM Transaction SINCE 1 day ago FACET appName"), note);
  assert.doesNotMatch(await runNrql(nrql({}), "SELECT count(*) AS 'Requests' FROM Log SINCE 1 day ago"), note);
  assert.doesNotMatch(await runNrql(nrql({}), "SELECT * FROM Log SINCE 1 day ago"), note);
  assert.doesNotMatch(await runNrql(nrql({}), "SHOW EVENT TYPES"), note);
});

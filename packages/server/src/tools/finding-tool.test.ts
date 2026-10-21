import { test } from "node:test";
import assert from "node:assert/strict";
import { findingFromMessages, findingMarkdown } from "@tracer-sh/shared";
import { WRITE_TOOLS } from "./tool-gate.js";
import { withSessionTools } from "./chat-tools.js";
import { reportFindingTool } from "./finding-tool.js";
import type { Db } from "../db/driver.js";

const valid = {
  kind: "root_cause" as const, verdict: "problem" as const, headline: "Pool exhausted by a retry storm",
  chain: [{ fact: "a 1" }, { fact: "b 2" }], confidence: "likely" as const,
};
const call = (input: unknown, state = "output-available") => ({ type: "tool-report_finding", toolCallId: "x", state, input, output: { recorded: true } });
const msgs = (...parts: unknown[]) => [{ parts: parts as { type: string }[] }];

test("findingFromMessages takes the last successful valid call", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ ...valid, headline: "later" }))), { ...valid, headline: "later" });
});

test("a card the review sent back is never the answer", () => {
  const rejected = { ...call({ ...valid, headline: "rejected" }), output: { recorded: false, problems: "x", next: "y" } };
  assert.deepEqual(findingFromMessages(msgs(call(valid), rejected)), valid);
  assert.equal(findingFromMessages(msgs(rejected)), null);
});

// The tool reads the sent-back cards from the history it is given, as the model sees it.
const sentBackResult = (problems: string) => ({
  role: "tool" as const,
  content: [{ type: "tool-result" as const, toolCallId: "p", toolName: "report_finding", output: { type: "json" as const, value: { recorded: false, problems, next: "n" } } }],
});

test("the card gets a review and a recheck: problems send it back, the third call is recorded", async () => {
  const earlierSeen: string[][] = [];
  const run = (problems: string | null) => {
    const t = reportFindingTool(async (_c, _m, _s, earlier) => { earlierSeen.push(earlier); return problems; }) as any;
    return (input: unknown, messages: unknown[] = []) => t.execute(input, { messages, toolCallId: "t" });
  };
  const sentBack = run("The headline names only the symptom.");
  const first = await sentBack(valid);
  assert.equal(first.recorded, false);
  assert.match(first.problems, /only the symptom/);
  const history = [sentBackResult(first.problems)];
  assert.equal((await sentBack(valid, history)).recorded, false);
  assert.deepEqual(await sentBack(valid, [...history, sentBackResult("again")]), { recorded: true });
  assert.deepEqual(earlierSeen, [[], [first.problems]]);
  assert.deepEqual(await run("OK")(valid), { recorded: true });
  assert.deepEqual(await run(null)(valid), { recorded: true });
});

test("a third card that switches to a new answer gets one last review", async () => {
  const sent = (id: string, headline: string) => [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, toolName: "report_finding", input: { ...valid, headline } }] },
    { ...sentBackResult("x"), content: [{ ...sentBackResult("x").content[0], toolCallId: id }] },
  ];
  const history = [...sent("a", "PROD-SVC-LOAN slowed"), ...sent("b", "PROD-SVC-LOAN slowed by a batch")];
  const t = reportFindingTool(async () => "still wrong") as any;
  const ask = (headline: string, messages: unknown[]) => t.execute({ ...valid, headline }, { messages, toolCallId: "t" });
  assert.deepEqual(await ask("PROD-SVC-LOAN slowed by a 62,758-call batch", history), { recorded: true });
  assert.equal((await ask("PROD-SVC-CREDIT-CARD-ACCOUNT had the biggest drop", history)).recorded, false);
  assert.deepEqual(await ask("PROD-SVC-USER doubled", [...history, ...sent("c", "PROD-SVC-CREDIT-CARD-ACCOUNT drop")]), { recorded: true });
  assert.deepEqual(await ask("No service names here", history), { recorded: true });
});

test("reviews that passed do not use up the budget, and the count starts at the turn", async () => {
  let n = 0;
  const t = reportFindingTool(async () => { n++; return n === 1 ? null : "problem"; }, () => 2) as any;
  const ask = (messages: unknown[]) => t.execute(valid, { messages, toolCallId: "t" });
  assert.deepEqual(await ask([]), { recorded: true });
  assert.equal((await ask([])).recorded, false, "a passed review is not a sent-back card");
  // Two sent-back cards before the turn start (index 2) are another turn's.
  const old = [sentBackResult("a"), sentBackResult("b"), { role: "user" as const, content: "next" }];
  assert.equal((await ask(old)).recorded, false);
  assert.deepEqual(await ask([...old, sentBackResult("c"), sentBackResult("d")]), { recorded: true });
});

test("findingFromMessages reads a root cause without confidence as unverified and accepts no chain", () => {
  const { confidence: _c, chain: _e, ...bare } = valid;
  assert.deepEqual(findingFromMessages(msgs(call(bare))), { ...bare, confidence: "unverified" });
  assert.match(findingMarkdown(bare), /^\*\*Problem\*\* \(unverified\):/);
});

test("findingFromMessages keeps inline markdown and findingMarkdown passes it through", () => {
  const fact = "**50 of 50** connections held; `PoolTimeoutError` from 10:05.";
  const card = { ...valid, chain: [{ fact }] };
  assert.equal(findingFromMessages(msgs(call(card)))?.chain?.[0].fact, fact);
  assert.ok(findingMarkdown(card).includes(fact));
});

test("findingFromMessages skips invalid input and unfinished calls", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ headline: "x" }), call({ ...valid, headline: "z" }, "input-available"))), valid);
  assert.equal(findingFromMessages(msgs(call({ ...valid, chain: ["1", "2", "3", "4", "5", "6", "7"].map((fact) => ({ fact })) }))), null);
  assert.equal(findingFromMessages([]), null);
});

test("every session gets report_finding", () => {
  assert.ok("report_finding" in withSessionTools({}, {} as Db, "s"));
  assert.ok(WRITE_TOOLS.has("report_finding"));
});

test("scoped extras override the general tool of the same name", () => {
  const provider = { execute_nrql: {}, ack_nr_issue: { id: "general" }, close_nr_issue: { id: "general" } };
  const tools = withSessionTools(provider, {} as Db, "s", { close_nr_issue: { id: "scoped" }, report_alert_summary: {} });
  assert.deepEqual(tools.close_nr_issue, { id: "scoped" });
  assert.deepEqual(tools.ack_nr_issue, { id: "general" });
  assert.deepEqual(Object.keys(tools).sort(), ["ack_nr_issue", "ask_user", "close_nr_issue", "execute_nrql", "report_alert_summary", "report_finding", "set_timer"]);
});

test("findingMarkdown renders the new sections and skips empty ones", () => {
  assert.equal(
    findingMarkdown({ ...valid, chain: [{ fact: "a 1", query: "Pool usage" }, { fact: "b 2" }], impact: "none", action: "Closed the issue", gap: "Pool metrics 10:00-10:15" }),
    "**Problem** (likely): Pool exhausted by a retry storm\n\n**Chain:**\n1. a 1 (query: Pool usage)\n2. b 2\n\n**Impact:** none\n\n**Action taken:** Closed the issue\n\n**Unknown:** Pool metrics 10:00-10:15",
  );
  assert.equal(findingMarkdown({ ...valid, verdict: "no_problem", confidence: "confirmed", chain: undefined }), "**No problem** (confirmed): Pool exhausted by a retry storm");
});

test("a summary parses, drops root-cause fields and renders as a summary", () => {
  const summary = { kind: "summary" as const, headline: "Checkout is healthy at 0.2% errors", details: "Errors stayed at 0.2% for the last hour.", points: ["p95 is 210 ms", "12k requests since 09:00"] };
  assert.deepEqual(findingFromMessages(msgs(call({ ...summary, confidence: "likely", gap: "x" }))), summary);
  assert.equal(findingMarkdown(summary), "**Summary:** Checkout is healthy at 0.2% errors\n\nErrors stayed at 0.2% for the last hour.\n\n- p95 is 210 ms\n- 12k requests since 09:00");
});

const legacy = { kind: "root_cause" as const, headline: "Pool exhausted", chain: [{ fact: "The pool held 50 of 50 connections." }, { fact: "a 1" }, { fact: "b 2" }], confidence: "likely" as const };

test("a call saved with the old rootCause shape still parses as a root cause", () => {
  const old = { rootCause: "Pool exhausted", evidence: ["a 1", "b 2"], confidence: "likely", nextStep: "ignored" };
  assert.deepEqual(findingFromMessages(msgs(call(old))), { kind: "root_cause", headline: "Pool exhausted", chain: [{ fact: "a 1" }, { fact: "b 2" }], confidence: "likely" });
});

test("an old root cause card maps details and points into the chain, with no verdict", () => {
  const old = { kind: "root_cause", headline: "Pool exhausted", details: "The pool held 50 of 50 connections.", points: ["a 1", "b 2"], confidence: "likely" };
  const f = findingFromMessages(msgs(call(old)));
  assert.deepEqual(f, legacy);
  assert.match(findingMarkdown(f!), /^\*\*Finding\*\* \(likely\): Pool exhausted\n\n\*\*Chain:\*\*\n1\. The pool held/);
  assert.deepEqual(findingFromMessages(msgs(call({ ...old, details: undefined, points: undefined }))), { kind: "root_cause", headline: "Pool exhausted", confidence: "likely" });
});

test("an old card with happened, cause, evidence and toConfirm becomes a chain and a gap", () => {
  const old = {
    kind: "root_cause", verdict: "problem", headline: "Pool exhausted", happened: "Pool full 10:05-10:12.", cause: " ",
    evidence: [{ fact: "a 1", query: "Pool usage" }, { fact: "" }], toConfirm: "Deploy history 14:35-14:45", confidence: "likely",
  };
  assert.deepEqual(findingFromMessages(msgs(call(old))), {
    kind: "root_cause", verdict: "problem", headline: "Pool exhausted", chain: [{ fact: "Pool full 10:05-10:12." }, { fact: "a 1", query: "Pool usage" }],
    gap: "Deploy history 14:35-14:45", confidence: "likely",
  });
});

test("a summary call saved without details parses with empty details and exports without a blank paragraph", () => {
  const s = { kind: "summary" as const, headline: "Healthy", points: [] };
  assert.equal(findingFromMessages(msgs(call(s)))?.details, "");
  assert.equal(findingMarkdown({ kind: "summary", headline: "Healthy", details: "", points: ["p 1"] }), "**Summary:** Healthy\n\n- p 1");
});

test("findingMarkdown appends the query title to a chain line", () => {
  const md = findingMarkdown({ ...valid, chain: [{ fact: "a 1", query: "Pool usage" }] });
  assert.match(md, /1\. a 1 \(query: Pool usage\)/);
});

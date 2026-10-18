import { test } from "node:test";
import assert from "node:assert/strict";
import { findingFromMessages, findingMarkdown } from "@tracer-sh/shared";
import { WRITE_TOOLS } from "./tool-gate.js";
import { withSessionTools } from "./chat-tools.js";
import type { Db } from "../db/driver.js";

const valid = {
  kind: "root_cause" as const, verdict: "problem" as const, headline: "Pool exhausted by a retry storm",
  happened: "The pool held 50 of 50 connections from 10:05 to 10:12.", cause: "A retry loop in checkout opened a connection per attempt.",
  evidence: [{ fact: "a 1" }, { fact: "b 2" }], confidence: "likely" as const,
};
const call = (input: unknown, state = "output-available") => ({ type: "tool-report_finding", toolCallId: "x", state, input, output: { recorded: true } });
const msgs = (...parts: unknown[]) => [{ parts: parts as { type: string }[] }];

test("findingFromMessages takes the last successful valid call", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ ...valid, headline: "later" }))), { ...valid, headline: "later" });
});

test("findingFromMessages reads a root cause without confidence as unverified and accepts no evidence", () => {
  const { confidence: _c, evidence: _e, ...bare } = valid;
  assert.deepEqual(findingFromMessages(msgs(call(bare))), { ...bare, confidence: "unverified" });
  assert.match(findingMarkdown(bare), /^\*\*Problem\*\* \(unverified\):/);
});

test("findingFromMessages keeps inline markdown and findingMarkdown passes it through", () => {
  const card = { ...valid, happened: "**50 of 50** connections held; `PoolTimeoutError` from 10:05." };
  assert.equal(findingFromMessages(msgs(call(card)))?.happened, card.happened);
  assert.ok(findingMarkdown(card).includes(card.happened));
});

test("findingFromMessages skips invalid input and unfinished calls", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ headline: "x" }), call({ ...valid, headline: "z" }, "input-available"))), valid);
  assert.equal(findingFromMessages(msgs(call({ ...valid, evidence: ["1", "2", "3", "4", "5", "6"].map((fact) => ({ fact })) }))), null);
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
    findingMarkdown({ ...valid, impact: "none", action: "Closed the issue", toConfirm: "Pool metrics" }),
    "**Problem** (likely): Pool exhausted by a retry storm\n\n**What happened:** The pool held 50 of 50 connections from 10:05 to 10:12.\n\n**Why:** A retry loop in checkout opened a connection per attempt.\n\n**Evidence:**\n- a 1\n- b 2\n\n**Impact:** none\n\n**Action taken:** Closed the issue\n\n**To confirm:** Pool metrics",
  );
  assert.equal(findingMarkdown({ ...valid, verdict: "no_problem", confidence: "confirmed", happened: undefined, evidence: undefined }), "**No problem** (confirmed): Pool exhausted by a retry storm\n\n**Why:** A retry loop in checkout opened a connection per attempt.");
});

test("a summary parses, drops root-cause fields and renders as a summary", () => {
  const summary = { kind: "summary" as const, headline: "Checkout is healthy at 0.2% errors", details: "Errors stayed at 0.2% for the last hour.", points: ["p95 is 210 ms", "12k requests since 09:00"] };
  assert.deepEqual(findingFromMessages(msgs(call({ ...summary, confidence: "likely", toConfirm: "x" }))), summary);
  assert.equal(findingMarkdown(summary), "**Summary:** Checkout is healthy at 0.2% errors\n\nErrors stayed at 0.2% for the last hour.\n\n- p95 is 210 ms\n- 12k requests since 09:00");
});

const legacy = { kind: "root_cause" as const, headline: "Pool exhausted", happened: "The pool held 50 of 50 connections.", evidence: [{ fact: "a 1" }, { fact: "b 2" }], confidence: "likely" as const };

test("a call saved with the old rootCause shape still parses as a root cause", () => {
  const old = { rootCause: "Pool exhausted", evidence: ["a 1", "b 2"], confidence: "likely", nextStep: "ignored" };
  assert.deepEqual(findingFromMessages(msgs(call(old))), { kind: "root_cause", headline: "Pool exhausted", evidence: [{ fact: "a 1" }, { fact: "b 2" }], confidence: "likely" });
});

test("an old root cause card maps details to happened and points to evidence, with no verdict", () => {
  const old = { kind: "root_cause", headline: "Pool exhausted", details: "The pool held 50 of 50 connections.", points: ["a 1", "b 2"], confidence: "likely" };
  const f = findingFromMessages(msgs(call(old)));
  assert.deepEqual(f, legacy);
  assert.match(findingMarkdown(f!), /^\*\*Finding\*\* \(likely\): Pool exhausted\n\n\*\*What happened:\*\* The pool held/);
  assert.deepEqual(findingFromMessages(msgs(call({ ...old, details: undefined, points: undefined }))), { kind: "root_cause", headline: "Pool exhausted", confidence: "likely" });
});

test("a summary call saved without details parses with empty details and exports without a blank paragraph", () => {
  const s = { kind: "summary" as const, headline: "Healthy", points: [] };
  assert.equal(findingFromMessages(msgs(call(s)))?.details, "");
  assert.equal(findingMarkdown({ kind: "summary", headline: "Healthy", details: "", points: ["p 1"] }), "**Summary:** Healthy\n\n- p 1");
});

test("findingMarkdown appends the query title to an evidence line", () => {
  const md = findingMarkdown({ ...valid, evidence: [{ fact: "a 1", query: "Pool usage" }] });
  assert.match(md, /- a 1 \(query: Pool usage\)/);
});


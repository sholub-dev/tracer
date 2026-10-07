import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_KIND, findingFromMessages, findingMarkdown } from "@tracer-sh/shared";
import { findingTools } from "./finding-tool.js";
import { WRITE_TOOLS } from "./tool-gate.js";
import { withSessionTools } from "./chat-tools.js";
import type { Db } from "../db/driver.js";

const valid = { kind: "root_cause" as const, headline: "Pool exhausted", details: "The pool held 50 of 50 connections.", points: ["a 1", "b 2"], confidence: "likely" as const };
const call = (input: unknown, state = "output-available") => ({ type: "tool-report_finding", toolCallId: "x", state, input, output: { recorded: true } });
const msgs = (...parts: unknown[]) => [{ parts: parts as { type: string }[] }];

test("findingFromMessages takes the last successful valid call", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ ...valid, headline: "later" }))), { ...valid, headline: "later" });
});

test("findingFromMessages skips invalid input and unfinished calls", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ headline: "x" }), call({ ...valid, headline: "z" }, "input-available"))), valid);
  assert.equal(findingFromMessages(msgs(call({ ...valid, points: ["one"] }))), null);
  assert.equal(findingFromMessages([]), null);
});

test("chat runs get report_finding and monitor runs do not", () => {
  assert.ok("report_finding" in findingTools());
  assert.ok("report_finding" in findingTools(SESSION_KIND.API));
  assert.deepEqual(findingTools(SESSION_KIND.MONITOR), {});
  assert.ok(WRITE_TOOLS.has("report_finding"));
});

test("monitor runs leave the New Relic issue actions to triage", () => {
  const provider = { execute_nrql: {}, list_nr_issues: {}, ack_nr_issue: {}, close_nr_issue: {} };
  const db = {} as Db;
  const chat = withSessionTools(provider, db, "s");
  for (const name of ["execute_nrql", "list_nr_issues", "ack_nr_issue", "close_nr_issue", "set_timer", "report_finding"]) assert.ok(name in chat, name);
  const monitor = withSessionTools(provider, db, "s", SESSION_KIND.MONITOR, { report_alert_summary: {} });
  assert.deepEqual(Object.keys(monitor).sort(), ["execute_nrql", "list_nr_issues", "report_alert_summary", "set_timer"]);
});

test("findingMarkdown shows the confidence and a to-confirm line only when present", () => {
  assert.equal(findingMarkdown({ ...valid, toConfirm: "Pool metrics" }), "**Root cause** (likely): Pool exhausted\n\nThe pool held 50 of 50 connections.\n\n- a 1\n- b 2\n\n**To confirm:** Pool metrics");
  assert.equal(findingMarkdown({ ...valid, confidence: "confirmed" }), "**Root cause** (confirmed): Pool exhausted\n\nThe pool held 50 of 50 connections.\n\n- a 1\n- b 2");
});

test("a summary parses, drops root-cause fields and renders as a summary", () => {
  const summary = { kind: "summary" as const, headline: "Checkout is healthy at 0.2% errors", details: "Errors stayed at 0.2% for the last hour.", points: ["p95 is 210 ms", "12k requests since 09:00"] };
  assert.deepEqual(findingFromMessages(msgs(call({ ...summary, confidence: "likely", toConfirm: "x" }))), summary);
  assert.equal(findingMarkdown(summary), "**Summary:** Checkout is healthy at 0.2% errors\n\nErrors stayed at 0.2% for the last hour.\n\n- p95 is 210 ms\n- 12k requests since 09:00");
});

test("a call saved with the old rootCause shape still parses as a root cause", () => {
  const old = { rootCause: "Pool exhausted", evidence: ["a 1", "b 2"], confidence: "likely", nextStep: "ignored" };
  assert.deepEqual(findingFromMessages(msgs(call(old))), { ...valid, details: "" });
});

test("a call saved without details parses with empty details and exports without a blank paragraph", () => {
  const { details, ...noDetails } = valid;
  assert.equal(findingFromMessages(msgs(call(noDetails)))?.details, "");
  assert.equal(findingMarkdown({ ...valid, details: "" }), "**Root cause** (likely): Pool exhausted\n\n- a 1\n- b 2");
});

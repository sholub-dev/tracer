import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { findAnalysisMarker } from "@tracer-sh/shared";
import { extractAnalysis } from "./analysis.js";

const msg = (parts: unknown[]) => ({ id: "", role: "assistant", parts }) as unknown as UIMessage;
const marker = { type: "tool-begin_analysis" };

test("extractAnalysis starts at the first marker of the last message that has one, like compaction", () => {
  const parts = [{ type: "text", text: "work" }, marker, { type: "text", text: "first" }, marker, { type: "text", text: "second" }];
  assert.equal(findAnalysisMarker(parts)?.partIdx, 1);
  assert.equal(extractAnalysis([msg(parts)]).analysis, "first\n\nsecond");
});

test("extractAnalysis keeps later messages after the marker", () => {
  const out = extractAnalysis([msg([marker, { type: "text", text: "a" }]), msg([{ type: "text", text: "b" }])]);
  assert.equal(out.analysis, "a\n\nb");
});

const finding = { kind: "root_cause", verdict: "problem", headline: "Pool exhausted", happened: "The pool held 50 of 50 connections.", cause: "Retries opened a connection per attempt.", evidence: [{ fact: "50 of 50 in use at 14:39" }, { fact: "p95 rose to 810 ms" }], confidence: "likely", toConfirm: "Gateway pool metrics for the spike window" };
const findingCall = (input: unknown) => ({ type: "tool-report_finding", toolCallId: "f", state: "output-available", input, output: { recorded: true } });

test("extractAnalysis puts the finding of the latest turn first", () => {
  const user = { id: "", role: "user", parts: [{ type: "text", text: "why?" }] } as unknown as UIMessage;
  const out = extractAnalysis([user, msg([marker, findingCall(finding), { type: "text", text: "Details" }])]).analysis;
  assert.equal(out, "**Problem** (likely): Pool exhausted\n\n**What happened:** The pool held 50 of 50 connections.\n\n**Why:** Retries opened a connection per attempt.\n\n**Evidence:**\n- 50 of 50 in use at 14:39\n- p95 rose to 810 ms\n\n**To confirm:** Gateway pool metrics for the spike window\n\nDetails");
  assert.equal(extractAnalysis([msg([marker, findingCall(finding)]), user, msg([marker, { type: "text", text: "Other" }])]).analysis, "Other");
});

test("extractAnalysis ignores a begin_analysis marker from an earlier turn", () => {
  const messages = [
    { id: "", role: "user", parts: [{ type: "text", text: "first" }] },
    { id: "", role: "assistant", parts: [{ type: "tool-begin_analysis" }, { type: "text", text: "old analysis" }] },
    { id: "", role: "user", parts: [{ type: "text", text: "second" }] },
    { id: "", role: "assistant", parts: [{ type: "text", text: "new answer" }] },
  ] as unknown as UIMessage[];
  assert.equal(extractAnalysis(messages).analysis, "new answer");
});

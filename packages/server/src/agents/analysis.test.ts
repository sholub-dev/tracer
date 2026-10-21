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

const finding = { kind: "root_cause", verdict: "problem", headline: "Pool exhausted", chain: [{ fact: "50 of 50 in use at 14:39" }, { fact: "p95 rose to 810 ms" }], confidence: "likely", gap: "Gateway pool metrics for the spike window" };
const findingCall = (input: unknown) => ({ type: "tool-report_finding", toolCallId: "f", state: "output-available", input, output: { recorded: true } });

test("extractAnalysis puts the finding of the latest turn first", () => {
  const user = { id: "", role: "user", parts: [{ type: "text", text: "why?" }] } as unknown as UIMessage;
  const out = extractAnalysis([user, msg([marker, findingCall(finding), { type: "text", text: "Details" }])]).analysis;
  assert.equal(out, "**Problem** (likely): Pool exhausted\n\n**Chain:**\n1. 50 of 50 in use at 14:39\n2. p95 rose to 810 ms\n\n**Unknown:** Gateway pool metrics for the spike window\n\nDetails");
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

test("extractAnalysis reads the reply a steered message trails", () => {
  const user = { id: "u", role: "user", parts: [{ type: "text", text: "why?" }] } as unknown as UIMessage;
  const steered = { id: "s", role: "user", metadata: { steered: true }, parts: [{ type: "text", text: "check the db" }] } as unknown as UIMessage;
  const reply = msg([marker, findingCall(finding), { type: "text", text: "Details" }]);
  assert.equal(extractAnalysis([user, reply, steered]).analysis, extractAnalysis([user, reply]).analysis);
});

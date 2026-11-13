import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { analysisSectionParts, compactionUpTo, findAnalysisMarker, isAnalysisMessage, splitAtAnalysis } from "@tracer-sh/shared";
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

const finding = { kind: "root_cause", verdict: "problem", title: "", answer: "Pool exhausted", explanation: [{ statement: "50 of 50 in use at 14:39", source: "Pool usage" }, { statement: "p95 rose to 810 ms", source: "Latency" }], confidence: "likely", unknown: "Gateway pool metrics for the spike window" };
const findingCall = (input: unknown) => ({ type: "tool-report_finding", toolCallId: "f", state: "output-available", input, output: { recorded: true } });

test("extractAnalysis puts the finding of the latest turn first", () => {
  const user = { id: "", role: "user", parts: [{ type: "text", text: "why?" }] } as unknown as UIMessage;
  const out = extractAnalysis([user, msg([marker, findingCall(finding), { type: "text", text: "Details" }])]).analysis;
  assert.equal(out, "**Problem (likely):** Pool exhausted\n\n**Why:**\n1. 50 of 50 in use at 14:39\n2. p95 rose to 810 ms\n\n**Unknown:** Gateway pool metrics for the spike window\n\n**Sources:**\n- Pool usage\n- Latency\n\nDetails");
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

test("extractAnalysis returns a text answer with its queries and turns result blocks into references", () => {
  const user = { id: "", role: "user", parts: [{ type: "text", text: "count?" }] } as unknown as UIMessage;
  const query = { type: "tool-execute_nrql", toolCallId: "q", state: "output-available", input: { query: "SELECT 1" }, output: { parts: [{ query: "SELECT 1", results: [{ n: 1 }] }], analysis: "n = 1" } };
  const out = extractAnalysis([user, msg([query, { type: "text", text: "One.\n\n```result\nCount\n```" }])]);
  assert.equal(out.analysis, "One.\n\n[Chart: Count]");
  assert.deepEqual(out.queries.map((q) => q.query), ["SELECT 1"]);
});

test("extractAnalysis keeps a text answer that a later tool call follows", () => {
  const user = { id: "", role: "user", parts: [{ type: "text", text: "count?" }] } as unknown as UIMessage;
  const query = { type: "tool-execute_nrql", toolCallId: "q", state: "output-available", input: { query: "SELECT 1" }, output: { parts: [{ query: "SELECT 1", results: [{ n: 1 }] }] } };
  const timer = { type: "tool-schedule_followup", toolCallId: "t", state: "output-available", input: {}, output: {} };
  const out = extractAnalysis([user, msg([{ type: "text", text: "Checking." }, query, { type: "text", text: "One." }, timer])]);
  assert.equal(out.analysis, "One.");
});

test("a card with no begin_analysis opens the analysis section at the card part", () => {
  const parts = [{ type: "step-start" }, { type: "tool-lookup" }, { type: "tool-report_finding" }, { type: "text" }];
  assert.deepEqual(findAnalysisMarker(parts), { kind: "card", partIdx: 2 });
  assert.deepEqual(splitAtAnalysis(parts), { before: parts.slice(0, 2), analysis: parts.slice(2) });
  assert.deepEqual(analysisSectionParts(parts), parts.slice(2));
  assert.equal(isAnalysisMessage({ role: "assistant", parts }), true);
  assert.equal(isAnalysisMessage({ role: "user", parts }), false);
  assert.equal(compactionUpTo([{ role: "user", parts: [] }, { role: "assistant", parts }], 1), 1);
});

test("begin_analysis and the text marker take precedence over a card", () => {
  const withTool = [{ type: "tool-report_finding" }, { type: "tool-begin_analysis" }];
  assert.deepEqual(findAnalysisMarker(withTool), { kind: "tool", partIdx: 1 });
  const withText: { type: string; text?: string }[] = [{ type: "tool-report_finding" }, { type: "text", text: "a <analysis> b" }];
  assert.equal(findAnalysisMarker(withText)?.kind, "text");
  assert.equal(findAnalysisMarker([{ type: "tool-lookup" }, { type: "text" }]), null);
  assert.equal(splitAtAnalysis([{ type: "text" }]), null);
});

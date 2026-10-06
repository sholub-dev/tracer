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

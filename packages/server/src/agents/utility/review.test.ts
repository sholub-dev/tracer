import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { buildTranscript } from "./review.js";
import { CONFIG } from "../../config.js";

const history: ModelMessage[] = [
  { role: "user", content: "old question" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "old_tool", input: { q: "old" } }] },
  { role: "user", content: [{ type: "text", text: "why are checkouts failing?" }] },
  { role: "assistant", content: [{ type: "text", text: "Checking errors." }, { type: "tool-call", toolCallId: "2", toolName: "run_query", input: { q: "errors" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "run_query", output: { type: "json", value: { rows: "x".repeat(5000) } } }] },
];

test("the transcript holds only the current run", () => {
  const t = buildTranscript(history);
  assert.match(t, /Question: why are checkouts failing\?/);
  assert.match(t, /Agent: Checking errors\./);
  assert.match(t, /Tool call run_query: {"q":"errors"}/);
  assert.doesNotMatch(t, /old/);
});

test("long tool outputs are clipped", () => {
  const t = buildTranscript(history);
  assert.ok(t.length < 2500);
  assert.match(t, /\(truncated\)/);
});

test("a transcript over the cap keeps its question and its end", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a".repeat(CONFIG.reviewTranscriptMaxChars) + "END" },
  ];
  const t = buildTranscript(msgs);
  assert.equal(t.length, CONFIG.reviewTranscriptMaxChars);
  assert.ok(t.startsWith("Question: q\n"));
  assert.ok(t.endsWith("END"));
});

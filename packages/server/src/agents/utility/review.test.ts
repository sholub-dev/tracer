import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage, UIMessage } from "ai";
import { buildTranscript, questionIndex } from "./review.js";
import { CONFIG } from "../../config.js";

const history: ModelMessage[] = [
  { role: "user", content: "old question" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "old_tool", input: { q: "old" } }] },
  { role: "user", content: [{ type: "text", text: "why are checkouts failing?" }] },
  { role: "assistant", content: [{ type: "text", text: "Checking errors." }, { type: "tool-call", toolCallId: "2", toolName: "run_query", input: { q: "errors" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "run_query", output: { type: "json", value: { rows: "x".repeat(5000) } } }] },
];

test("the transcript holds only the current run", () => {
  const t = buildTranscript(history, 2);
  assert.match(t, /Question: why are checkouts failing\?/);
  assert.match(t, /Agent: Checking errors\./);
  assert.match(t, /Tool call run_query: {"q":"errors"}/);
  assert.doesNotMatch(t, /old/);
});

test("long tool outputs are clipped", () => {
  const t = buildTranscript(history, 2);
  assert.ok(t.length < 2500);
  assert.match(t, /\(truncated\)/);
});

test("a transcript over the cap keeps its question and its end", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a".repeat(CONFIG.reviewTranscriptMaxChars) + "END" },
  ];
  const t = buildTranscript(msgs, 0);
  assert.equal(t.length, CONFIG.reviewTranscriptMaxChars);
  assert.ok(t.startsWith("Question: q\n"));
  assert.ok(t.endsWith("END"));
});

test("a message sent during the run stays in order and does not cut the turn", () => {
  const msgs: ModelMessage[] = [
    ...history,
    { role: "user", content: [{ type: "text", text: "also check the cache" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "3", toolName: "run_query", input: { q: "cache" } }] },
  ];
  const t = buildTranscript(msgs, 2);
  assert.match(t, /^Question: why are checkouts failing\?/);
  assert.match(t, /Tool call run_query: {"q":"errors"}/);
  assert.ok(t.indexOf("errors") < t.indexOf("User: also check the cache"));
  assert.ok(t.indexOf("User: also check the cache") < t.indexOf('{"q":"cache"}'));
});

const asked: ModelMessage[] = [
  { role: "user", content: "old question" },
  { role: "assistant", content: "old answer" },
  { role: "user", content: "why are checkouts failing?" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "2", toolName: "run_query", input: { q: "errors" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "run_query", output: { type: "json", value: "rows" } }] },
];
const text = (role: "user" | "assistant", value: string): UIMessage => ({ id: "", role, parts: [{ type: "text", text: value }] });
const steeredMessage: ModelMessage = { role: "user", content: "also check the cache" };

test("the repair pass nudge and a steered message do not replace the question", () => {
  const nudge: ModelMessage = { role: "user", content: "Call report_finding now with the answer to the question." };
  const ui: UIMessage[] = [text("user", "old question"), text("assistant", "old answer"), text("user", "why are checkouts failing?"), text("assistant", "tool work")];
  const index = questionIndex(ui, asked);
  const t = buildTranscript([...asked, steeredMessage, nudge], index);
  assert.match(t, /^Question: why are checkouts failing\?/);
  assert.match(t, /User: also check the cache/);
});

test("a message saved before a restart does not replace the question of the resumed run", () => {
  const ui: UIMessage[] = [text("user", "old question"), text("assistant", "old answer"), text("user", "why are checkouts failing?"), text("assistant", "tool work"), { ...text("user", "also check the cache"), metadata: { steered: true } }];
  const index = questionIndex(ui, [...asked, steeredMessage]);
  const t = buildTranscript([...asked, steeredMessage], index);
  assert.match(t, /^Question: why are checkouts failing\?/);
  assert.match(t, /User: also check the cache/);
});

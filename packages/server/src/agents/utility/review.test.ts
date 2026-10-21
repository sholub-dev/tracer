import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage, UIMessage } from "ai";
import { buildTranscript, cardProblems, harnessNote, questionIndex, reviewProblems } from "./review.js";
import { CONFIG } from "../../config.js";

const history: ModelMessage[] = [
  { role: "user", content: "old question" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "old_tool", input: { q: "old" } }] },
  { role: "user", content: [{ type: "text", text: "why are checkouts failing?" }] },
  { role: "assistant", content: [{ type: "text", text: "Checking errors." }, { type: "tool-call", toolCallId: "2", toolName: "run_query", input: { q: "errors" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "run_query", output: { type: "json", value: { rows: "x".repeat(9000) } } }] },
];

test("the transcript marks earlier questions apart from the current run", () => {
  const t = buildTranscript(history, 2);
  assert.match(t, /^Question: why are checkouts failing\?\nEarlier in this session:\nUser: old question\n.*\nThe reply to the question:\nAgent: Checking errors\./s);
  assert.match(t, /Tool call run_query: {"q":"errors"}/);
});

test("a long result is shown as plain text and cut at 8000 characters", () => {
  const t = buildTranscript(history, 2);
  assert.ok(t.length > 8000 && t.length < 8400);
  assert.match(t, /… \(cut for the review\)$/);
  const wrapped: ModelMessage[] = [
    { role: "user", content: "q" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "run_query", output: { type: "text", value: "<tool_result>\nrow 1\nrow 2\n</tool_result>" } }] },
  ];
  assert.match(buildTranscript(wrapped, 0), /Result run_query: row 1\nrow 2$/);
});

test("a transcript over the cap keeps its question and its newest whole lines, and says how many it dropped", () => {
  const line = "a".repeat(CONFIG.reviewTranscriptMaxChars / 4);
  const msgs: ModelMessage[] = [{ role: "user", content: "q" }];
  for (let i = 0; i < 6; i++) msgs.push({ role: "assistant", content: `${i}${line}` });
  const t = buildTranscript(msgs, 0);
  assert.ok(t.length <= CONFIG.reviewTranscriptMaxChars);
  assert.ok(t.startsWith("Question: q\n(3 earlier lines omitted)\nAgent: 3"));
  assert.ok(t.includes("Agent: 5"));
});

test("a harness note is not shown as the person's words, and results of the same step are listed", () => {
  const msgs: ModelMessage[] = [{ role: "user", content: "q" }, harnessNote("This is the last step."), { role: "user", content: "and the cache?" }];
  const t = buildTranscript(msgs, 0, [{ toolName: "run_query", input: { q: "errors" }, text: "12 rows" }]);
  assert.match(t, /Harness note: This is the last step\.\nUser: and the cache\?/);
  assert.match(t, /Results from this step.*\nTool call run_query: {"q":"errors"}\nResult run_query: 12 rows$/);
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

test("step reads reach the reviewer without the result wrapper", () => {
  const t = buildTranscript([], -1, [{ toolName: "run_query", input: {}, text: "<tool_result>\n12 rows\n</tool_result>" }]);
  assert.match(t, /Result run_query: 12 rows$/);
});

test("a review that ends in OK is a pass", () => {
  assert.equal(reviewProblems("OK"), null);
  assert.equal(reviewProblems("All numbers appear in results.\nNo repeats.\n\n**OK**"), null);
  assert.equal(reviewProblems("  "), null);
  assert.equal(reviewProblems("- The headline lacks the lead.\n- Gap is empty."), "- The headline lacks the lead.\n- Gap is empty.");
});

test("the transcript shows results of earlier questions in the session", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Biggest drop?" },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "execute_nrql", output: { type: "text", value: "<tool_result>\nrequests,4048\n</tool_result>" } }] },
    { role: "user", content: "Who sent them?" },
  ];
  const t = buildTranscript(messages, 2);
  assert.match(t, /^Question: Who sent them\?/);
  assert.match(t, /Earlier in this session:\nUser: Biggest drop\?\nResult execute_nrql: requests,4048\nThe reply to the question:/);
});

test("only the PROBLEMS section of a card review goes back, and OK is a pass", () => {
  assert.equal(cardProblems("CLAIMS\n- headline: 12,345 errors | 12345 errors\nPROBLEMS\nOK"), null);
  assert.equal(cardProblems("### CLAIMS\n- headline: x | NONE\n### PROBLEMS\n- gap: lacks a runner-up."), "- gap: lacks a runner-up.");
  assert.equal(cardProblems("**PROBLEMS:**\n- headline: no number."), "- headline: no number.");
  assert.equal(cardProblems("CLAIMS\n- impact: 195,396 | 195396\nPROBLEMS: none of these hold.\nWait, the sum matches.\nPROBLEMS OK"), null);
  assert.equal(cardProblems("CLAIMS\n- headline: 19.84s | 19.84\nPROBLEMS\n- headline: the lead is wrong. Wait, 38.999 - 19.16 = 19.839, that rounds right.\nOK"), null);
});

test("a card review without a PROBLEMS header falls back to the last-line check", () => {
  assert.equal(cardProblems("Reasoning.\nOK"), null);
  assert.equal(cardProblems("headline is a symptom."), "headline is a symptom.");
});

test("earlier cards stay out of the review transcript", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Why?" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "report_finding", input: { headline: "old card" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "report_finding", output: { type: "json", value: { recorded: false } } }] },
  ];
  assert.doesNotMatch(buildTranscript(messages, 0), /report_finding|old card/);
});

test("a follow-up review sees the card the person got, not the drafts the review sent back", () => {
  const card = (id: string, headline: string, recorded: boolean): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "report_finding", input: { headline } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "report_finding", output: { type: "json", value: recorded ? { recorded: true } : { recorded: false, problems: "x", next: "y" } } }] },
  ];
  const messages: ModelMessage[] = [
    { role: "user", content: "Biggest drop?" },
    ...card("a", "Treasury draft", false),
    ...card("b", "Card account answer", true),
    { role: "user", content: "Who sent them?" },
    ...card("c", "Current draft", false),
  ];
  const t = buildTranscript(messages, 5);
  assert.match(t, /Answer shown to the person: .*Card account answer/);
  assert.doesNotMatch(t, /Treasury draft|Current draft/);
});

test("a query the card cites stays in an over-long transcript", () => {
  const call = (id: string, title: string, value: string): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "execute_nrql", input: { title, query: id } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "execute_nrql", output: { type: "text", value } }] },
  ];
  const bulk = Array.from({ length: Math.ceil(CONFIG.reviewTranscriptMaxChars / 8000) + 2 }, (_, i) => call(`b${i}`, `Big ${i}`, "x".repeat(8000))).flat();
  const messages: ModelMessage[] = [
    { role: "user", content: "Worst service?" },
    ...call("r", "Ranking of all services", "svc-a,56250"),
    ...bulk,
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "l", toolName: "execute_nrql", input: { title: "Last", query: "q3" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "l", toolName: "execute_nrql", output: { type: "text", value: "last,1" } }] },
  ];
  assert.doesNotMatch(buildTranscript(messages, 0), /56250/);
  const t = buildTranscript(messages, 0, [], ["ranking of all services "]);
  assert.match(t, /^Question: Worst service\?\n\(\d+ earlier lines omitted\)\nTool call execute_nrql: .*Ranking of all services.*\nResult execute_nrql: svc-a,56250\n/);
  assert.match(t, /last,1$/);
  assert.ok(t.length <= CONFIG.reviewTranscriptMaxChars + 100);
});

test("an alert summary review reply is parsed like a card review, and the summary is not evidence", () => {
  assert.equal(cardProblems("CLAIMS\n- issues[0].errors: 76 × Auth0Exception | 76,Auth0Exception\nPROBLEMS\nOK"), null);
  assert.equal(cardProblems("CLAIMS\n- issues[0].errors: 318 × Auth0Exception | NONE\nPROBLEMS\n- issues[0].errors: 318 is the endpoint total, not the Auth0Exception count."), "- issues[0].errors: 318 is the endpoint total, not the Auth0Exception count.");
  const messages: ModelMessage[] = [
    { role: "user", content: "Check the alert" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "s", toolName: "report_alert_summary", input: { policy: "draft" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "s", toolName: "report_alert_summary", output: { type: "json", value: { recorded: false, problems: "x", next: "y" } } }] },
  ];
  assert.doesNotMatch(buildTranscript(messages, 0), /report_alert_summary|draft/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { CONFIG } from "../config.js";
import { citedOriginals, maskContext, restoreContext } from "./context-mask.js";

const big = (tag: string) => `<tool_result>\n${Array.from({ length: 40 }, (_, i) => `${tag} row ${i} ${"x".repeat(60)}`).join("\n")}\n</tool_result>`;
const call = (id: string, toolName = "query", title?: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName, input: title ? { title } : {} }] });
const result = (id: string, text: string, toolName = "query"): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value: text } }] });
const user = (text: string): ModelMessage => ({ role: "user", content: text });
const value = (m: ModelMessage) => ((m.content as { output: { value: string } }[])[0]).output.value;

/** One earlier question, then a question with `steps` query steps. */
function session(steps: number, toolName = "query") {
  const msgs: ModelMessage[] = [user("q1"), call("old", "query", "Old query"), result("old", big("old")), user("q2")];
  for (let i = 0; i < steps; i++) msgs.push(call(`c${i}`, toolName, `Step ${i}`), result(`c${i}`, big(`c${i}`), toolName));
  return { msgs, start: 3 };
}
const stubbed = (m: ModelMessage) => value(m).startsWith("Cut from the context");

test("results of earlier questions are masked from the first step", () => {
  const { msgs, start } = session(1);
  const out = maskContext(msgs, start, new Map());
  assert.ok(stubbed(out[2]));
  assert.ok(!stubbed(out[5]));
});

test("current results stay until the watermark passes them", () => {
  const { keep, every } = { keep: CONFIG.contextKeepSteps, every: CONFIG.contextMaskEverySteps };
  const { msgs, start } = session(keep + every);
  const out = maskContext(msgs, start, new Map());
  const masked = out.filter((m, i) => i > start && m.role === "tool" && stubbed(m)).length;
  assert.equal(masked, Math.floor((keep + every) / every) * every - keep);
  assert.ok(stubbed(out[start + 2]));
  assert.ok(!stubbed(out[start + 2 * every + 2]));
});

test("the input is identical for every step between two watermark moves", () => {
  const every = CONFIG.contextMaskEverySteps;
  const base = 2 * every;
  const inputs = Array.from({ length: every }, (_, i) => {
    const { msgs, start } = session(base + i);
    return maskContext(msgs, start, new Map());
  });
  const prefix = inputs[0].length;
  for (const input of inputs) assert.deepEqual(input.slice(0, prefix), inputs[0].slice(0, prefix));
});

test("small results and the report and analysis tools stay whole", () => {
  const small = [user("q1"), call("a"), result("a", "short"), call("b", "report_finding"), result("b", big("b"), "report_finding"), call("c", "begin_analysis"), result("c", big("c"), "begin_analysis"), user("q2")];
  const out = maskContext(small, 7, new Map());
  assert.deepEqual(out, small);
});

test("an analysis result of an earlier question loses its copies of cited results", () => {
  const ledger = (id: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "begin_analysis", output: { type: "json", value: { status: "s", cited: big(id) } } }] });
  const msgs = [user("q1"), call("old", "begin_analysis"), ledger("old"), user("q2"), call("new", "begin_analysis"), ledger("new")];
  const out = maskContext(msgs, 3, new Map());
  assert.deepEqual((out[2].content as { output: unknown }[])[0].output, { type: "json", value: { status: "s" } });
  assert.deepEqual(out[5], msgs[5]);
});

test("a stub is deterministic and names the id, the title and the line count", () => {
  const { msgs, start } = session(1);
  const a = value(maskContext(msgs, start, new Map())[2]);
  assert.equal(a, value(maskContext(msgs, start, new Map())[2]));
  assert.ok(a.includes('read_result with id "old"'));
  assert.ok(a.includes("Old query: 42 lines."));
  assert.ok(a.includes("First lines:\nold row 0 "));
  assert.ok(!a.includes("<tool_result>"));
  assert.ok(a.split("First lines:\n")[1].split("\n").length <= 6);
});

test("masking twice changes nothing and restoring returns the original messages", () => {
  const { msgs, start } = session(25);
  const originals = new Map<string, string>();
  const once = maskContext(msgs, start, originals);
  assert.deepEqual(maskContext(once, start, originals), once);
  assert.notDeepEqual(once, msgs);
  assert.deepEqual(restoreContext(once, originals), msgs);
});

test("the analysis gets the whole text of the cut results its chain cites, within the cap", () => {
  const call = (id: string, title: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "execute_nrql", input: { title } }] });
  const messages = [call("a", "Ranking of all services"), call("b", "Callers"), call("c", "Uncited")];
  const originals = new Map([["a", "svc-a,56250"], ["b", "x".repeat(50)], ["c", "never"]]);
  const text = citedOriginals("Spike of 56,250 [Ranking of all services], sent by one client [callers].", messages, originals, 20)!;
  assert.match(text, /Ranking of all services:\nsvc-a,56250/);
  assert.match(text, /Call read_result for these cited results before the card: "b" \(Callers\)/);
  assert.doesNotMatch(text, /never/);
  assert.equal(citedOriginals("[Not cut]", messages, originals, 20), undefined);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { capQueryRows, decodeMessages, decodeMessagesJson, encodeMessages, isPacked, MAX_SAVED_ROWS } from "./messages-codec.js";

const rows = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));

export function chat(results: unknown[], extra: Record<string, unknown> = {}): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "why?" }, { type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] },
    { id: "", role: "assistant", parts: [
      { type: "text", text: "Looking." },
      { type: "tool-execute_nrql", toolCallId: "t1", state: "output-available", input: { query: "q" },
        output: { parts: [{ type: "query", query: "q", results, ...extra }], analysis: "a,b\n1,2" } },
    ] },
  ] as UIMessage[];
}
const resultsOf = (m: UIMessage[]) => (m[1].parts[1] as any).output.parts[0];

test("round trip keeps messages and reads legacy JSON", () => {
  const messages = chat([{ a: 1 }]);
  const packed = encodeMessages(messages);
  assert.ok(isPacked(packed));
  assert.deepEqual(decodeMessages(packed), messages);
  assert.deepEqual(decodeMessages(JSON.stringify(messages)), messages);
  assert.equal(decodeMessagesJson("[]"), "[]");
  assert.equal(decodeMessagesJson(packed), JSON.stringify(messages));
});

test("table rows are capped and the original count is kept", () => {
  const part = resultsOf(decodeMessages(encodeMessages(chat(rows(500, (i) => ({ id: i, name: "x" }))))));
  assert.equal(part.results.length, MAX_SAVED_ROWS);
  assert.equal(part.results[99].id, 99);
  assert.equal(part.totalRows, 500);
});

test("value lists are capped; short results stay untouched", () => {
  assert.equal(resultsOf(capQueryRows(chat(rows(300, (i) => i)))).results.length, MAX_SAVED_ROWS);
  const short = chat(rows(100, (i) => ({ id: i })));
  assert.equal(capQueryRows(short)[1], short[1]);
  assert.equal(resultsOf(capQueryRows(short)).totalRows, undefined);
});

test("chart results keep every row", () => {
  for (const make of [(i: number) => ({ beginTimeSeconds: i, count: i }), (i: number) => ({ comparison: "current", facet: i, count: i })]) {
    const part = resultsOf(capQueryRows(chat(rows(500, make))));
    assert.equal(part.results.length, 500);
    assert.equal(part.totalRows, undefined);
  }
});

test("legacy output.queries are capped too", () => {
  const messages = [{ id: "", role: "assistant", parts: [{ type: "tool-nrql", state: "output-available", output: { queries: [{ query: "q", results: rows(250, (i) => ({ i })) }], analysis: "x" } }] }] as unknown as UIMessage[];
  const q = (capQueryRows(messages)[0].parts[0] as any).output.queries[0];
  assert.equal(q.results.length, MAX_SAVED_ROWS);
  assert.equal(q.totalRows, 250);
});

test("capping is idempotent and keeps an earlier total", () => {
  const once = capQueryRows(chat(rows(500, (i) => ({ i }))));
  assert.equal(capQueryRows(once)[1], once[1]);
  assert.deepEqual(decodeMessages(encodeMessages(decodeMessages(encodeMessages(once)))), once);
  assert.equal(resultsOf(capQueryRows(chat(rows(150, (i) => ({ i })), { totalRows: 900 }))).totalRows, 900);
});

test("error outputs and non-array results pass through", () => {
  const messages = [{ id: "", role: "assistant", parts: [{ type: "tool-x", state: "output-available", output: { error: "bad" } }, { type: "tool-y", state: "output-available", output: { parts: [{ type: "query", query: "q", results: { error: "e" } }] } }] }] as unknown as UIMessage[];
  assert.equal(capQueryRows(messages)[0], messages[0]);
});

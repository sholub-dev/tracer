import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHogqlCsv, rowsToObjects } from "./posthog-formatter.js";

test("shows every row that fits the text budget", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ n: i }));
  const out = formatHogqlCsv(rows);
  assert.equal(out.split("\n").length, 1 + 70);
  assert.doesNotMatch(out, /Showing/);
});

test("a result over the text budget says how many rows are shown", () => {
  const rows = Array.from({ length: 100 }, () => ({ s: "x".repeat(900) }));
  const out = formatHogqlCsv(rows, "SELECT s FROM events LIMIT 500");
  assert.match(out, /Showing 3\d of 100 rows/);
  assert.match(out, /lower the LIMIT/);
  assert.ok(out.length < 31_000);
});

test("cells keep null, empty strings, long strings and arrays of objects", () => {
  const out = formatHogqlCsv([{ a: null, b: "", c: "y".repeat(1500), d: [{ k: 1 }, { k: 2 }], e: Array.from({ length: 60 }, (_, i) => i), f: '{"a": 1,  "b": [2]}' }]);
  const [, row] = out.split("\n");
  assert.ok(row.startsWith("null,,"));
  assert.match(row, /… \(\+500 chars\)/);
  assert.match(row, /"{""k"":1}; {""k"":2}"/);
  assert.match(row, /… \+10 more/);
  assert.match(row, /"{""a"":1,""b"":\[2\]}"/);
  assert.doesNotMatch(row, /\[object Object\]/);
});

test("duplicate column names get a suffix", () => {
  const rows = rowsToObjects({ columns: ["count()", "count()", "id", "id"], results: [[1, 2, 3, 4]] });
  assert.deepEqual(rows, [{ "count()": 1, "count()_2": 2, id: 3, id_2: 4 }]);
});

test("a LIMIT inside a subquery is not the row limit", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  assert.doesNotMatch(formatHogqlCsv(rows, "SELECT id FROM (SELECT id FROM events LIMIT 100) LIMIT 500"), /row limit/);
  assert.match(formatHogqlCsv(rows, "SELECT id FROM (SELECT id FROM events LIMIT 5)"), /row limit of 100/);
});

test("small non-integers keep three significant digits", () => {
  assert.equal(formatHogqlCsv([{ a: 0.004 }]), "a\n0.004");
  assert.equal(formatHogqlCsv([{ a: 2.567 }]), "a\n2.57");
});

test("a result that fills its row limit says it is not a total", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  assert.match(formatHogqlCsv(rows, "SELECT id FROM events"), /row limit of 100/);
  assert.match(formatHogqlCsv(rows, "SELECT id FROM events LIMIT 100"), /row limit of 100/);
  assert.doesNotMatch(formatHogqlCsv(rows, "SELECT id FROM events LIMIT 500"), /row limit/);
});

test("the word limit inside a string literal is not a LIMIT clause", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  assert.match(formatHogqlCsv(rows, "SELECT id FROM events WHERE event = 'rate limit hit'"), /row limit of 100/);
});

test("a JSON string keeps integers above 2^53 and LIMIT a, b uses the count", () => {
  assert.ok(formatHogqlCsv([{ p: '{ "id": 9007199254740993 }' }]).includes('{""id"":9007199254740993}'));
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  assert.match(formatHogqlCsv(rows, "SELECT id FROM events LIMIT 5, 10"), /row limit of 10/);
});

test("a single row over the budget is cut with a note", () => {
  const out = formatHogqlCsv([Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, "x".repeat(900)]))]);
  assert.ok(out.includes("(Row cut at 30000 characters; select fewer columns.)"));
  assert.ok(out.length <= 30000 + 100);
});

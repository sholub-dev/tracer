import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHogqlCsv } from "./posthog-formatter.js";

test("shows 50 rows and notes the rest", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ n: i }));
  const out = formatHogqlCsv(rows);
  assert.equal(out.split("\n").length, 1 + 50 + 1);
  assert.match(out, /\(20 more rows omitted\)$/);
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

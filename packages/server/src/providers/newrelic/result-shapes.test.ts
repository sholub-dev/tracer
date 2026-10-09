import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeNewRelicRows } from "@tracer-sh/shared";
import { formatNrqlCsv } from "./nrql-formatter.js";

const row = { "apdex.x": { count: 676, f: 2, s: 638, score: 0.97, t: 36 }, count: 676, f: 2, s: 638, score: 0.97, t: 36 };

test("model output lists an object field once", () => {
  const csv = formatNrqlCsv(normalizeNewRelicRows([row]));
  assert.equal(csv.match(/676/g)?.length, 1);
  assert.ok(csv.indexOf("0.97") < csv.indexOf("676"));
  assert.ok(formatNrqlCsv([row]).match(/676/g)!.length > 1);
});

test("model output prints arrays of objects as JSON", () => {
  assert.match(formatNrqlCsv([{ a: [{ k: 1 }] }]), /\{""k"":1\}/);
});

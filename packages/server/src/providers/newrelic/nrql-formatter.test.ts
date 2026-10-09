import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNrqlCsv } from "./nrql-formatter.js";

const facets = (n: number) => Array.from({ length: n }, (_, i) => ({ facet: `f${i}`, count: i + 1 }));

test("faceted table shows 50 rows and notes the rest", () => {
  const out = formatNrqlCsv(facets(60));
  assert.equal(out.split("\n").length, 1 + 50 + 1);
  assert.match(out, /\(10 more rows omitted\)$/);
});

test("a faceted result that fills its row limit gets the not-a-total note", () => {
  const note = "row limit of 10";
  assert.ok(formatNrqlCsv(facets(10), "SELECT count(*) FROM Transaction FACET name").includes(note));
  assert.ok(formatNrqlCsv(facets(10), "SELECT count(*) FROM Transaction FACET name LIMIT 10").includes(note));
  assert.ok(!formatNrqlCsv(facets(10), "SELECT count(*) FROM Transaction FACET name LIMIT 20").includes("row limit"));
  assert.ok(!formatNrqlCsv(facets(10), "SELECT count(*) FROM Transaction FACET name LIMIT MAX").includes("row limit"));
  assert.ok(!formatNrqlCsv(facets(10)).includes(note));
  assert.ok(!formatNrqlCsv(facets(9), "SELECT count(*) FROM Transaction FACET name").includes(note));
});

test("raw events at 100 rows get the note", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ message: `m${i}` }));
  const out = formatNrqlCsv(rows, "SELECT message FROM Log");
  assert.match(out, /\(50 more rows omitted\)/);
  assert.match(out, /row limit of 100; there can be more\. This is not a total\.\)$/);
});

test("downsampled timeseries keeps the peak and low rows in time order", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    beginTimeSeconds: i,
    endTimeSeconds: `t${String(i).padStart(2, "0")}`,
    v: i === 13 ? 1000 : i === 27 ? -5 : 10,
  }));
  const out = formatNrqlCsv(rows);
  assert.ok(out.includes("t13,1000"));
  assert.ok(out.includes("t27,-5"));
  assert.ok(out.indexOf("t13,") < out.indexOf("t27,"));
  assert.match(out, /plus the peak and low points\)$/);
});

test("downsampled timeseries keeps the peak and low rows of object members", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    beginTimeSeconds: i,
    endTimeSeconds: `t${String(i).padStart(2, "0")}`,
    "apdex.x": { score: i === 13 ? 0.2 : 0.9 },
  }));
  assert.ok(formatNrqlCsv(rows).includes("t13,"));
});

test("small non-integers keep three significant digits", () => {
  assert.equal(formatNrqlCsv([{ a: 0.004 }]), "a: 0.004");
  assert.equal(formatNrqlCsv([{ a: 0 }]), "a: 0");
  assert.equal(formatNrqlCsv([{ a: 1.234 }]), "a: 1.23");
});

test("faceted timeseries keeps the facet column", () => {
  const rows = ["a", "b"].flatMap((app) => [0, 1].map((i) => ({ beginTimeSeconds: i, endTimeSeconds: `t${i}`, facet: app, appName: app, count: i })));
  assert.equal(formatNrqlCsv(rows), "Time,appName,count\nt0,a,0\nt1,a,1\nt0,b,0\nt1,b,1");
});

test("the word limit inside a string literal is not a LIMIT clause", () => {
  assert.ok(formatNrqlCsv(facets(10), "SELECT count(*) FROM Transaction WHERE request.uri LIKE '%rate-limit%' FACET name").includes("row limit of 10"));
});

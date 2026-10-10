import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { dropFlattenedCopies, dropFlattenedResultCopies, mainMemberKey, normalizeNewRelicRows } from "@tracer-sh/shared";
import { buildColumns, coerceNumeric, dropFlattenedRowCopies, expandObjectColumns, formatValue, isNumericGroup, mainMemberColumns } from "./result-utils";
import { getMetricKeys } from "../components/charts/ChartView";
import { KeyFigures } from "../components/charts/KeyFigures";

const apdexRow = { "apdex.x": { count: 676, f: 2, s: 638, score: 0.97, t: 36 }, count: 676, f: 2, s: 638, score: 0.97, t: 36 };

test("drops members copied next to their object, in query order", () => {
  assert.deepEqual(Object.keys(dropFlattenedCopies(apdexRow)), ["apdex.x"]);
});

test("keeps every key when only some members match a real column", () => {
  const row = { n: 1, "apdex.x": { count: 676, score: 0.97 }, count: 676, score: 0.5 };
  assert.deepEqual(dropFlattenedCopies(row), row);
  const plain = { a: 1 };
  assert.equal(dropFlattenedCopies(plain), plain);
});

test("a real column equal to one member stays when the set is not complete", () => {
  const row = { "apdex.x": { count: 676, score: 0.97 }, count: 676 };
  assert.deepEqual(dropFlattenedCopies(row), row);
});

test("cleans flattened copies only for New Relic results", () => {
  assert.deepEqual(Object.keys((dropFlattenedRowCopies([apdexRow], "newrelic") as object[])[0]), ["apdex.x"]);
  const row = { id: 5, name: "a", owner: { id: 5, name: "a" } };
  const rows = [row];
  assert.equal(dropFlattenedRowCopies(rows, "gcp"), rows);
  assert.equal(dropFlattenedRowCopies(rows), rows);
  assert.equal(dropFlattenedRowCopies(rows, "posthog"), rows);
});

test("expands object columns into one column per member, in order", () => {
  const rows = [{ t: 1, o: { a: 1, b: { c: 2 } }, p: { "95": 3 }, z: 4 }, { t: 2, o: { a: 5, b: { c: 6 } }, p: { "95": 7 }, z: 8 }];
  const out = expandObjectColumns(rows);
  assert.deepEqual(Object.keys(out[0]), ["t", "o.a", "o.b.c", "p", "z"]);
  assert.deepEqual(out[1], { t: 2, "o.a": 5, "o.b.c": 6, p: { "95": 7 }, z: 8 });
  assert.equal(coerceNumeric({ count: 1, score: 0.9 }), null);
  assert.equal(expandObjectColumns([{ a: 1 }])[0].a, 1);
});

test("leaves arrays and null values alone", () => {
  const row = { a: [1, 2], b: null, c: { x: 1 }, x: null };
  assert.deepEqual(dropFlattenedCopies(row), row);
});

test("columns of a normalized row show the object once", () => {
  assert.deepEqual(buildColumns([dropFlattenedCopies(apdexRow)]).map((c) => c.key), ["apdex.x"]);
});

test("formats arrays of objects as JSON, not [object Object]", () => {
  assert.equal(formatValue([{ a: 1 }, "b"]), '{"a":1}, b');
});

test("key figures render an object as one group of tiles", () => {
  const row = dropFlattenedCopies(apdexRow);
  const html = renderToStaticMarkup(<KeyFigures columns={buildColumns([row])} row={row} />);
  assert.equal(html.split("apdex.x").length - 1, 1);
  assert.ok(!html.includes("{&quot;"));
  assert.deepEqual([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]), ["apdex.x", "count", "f", "s", "score", "t"]);
});

test("key figures group nested objects and break long values", () => {
  const row = { a: { b: { c: 1 }, d: 22222222222222 } };
  const html = renderToStaticMarkup(<KeyFigures columns={buildColumns([row])} row={row} />);
  assert.deepEqual([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((m) => m[1]), ["a", "b", "c", "d"]);
  assert.ok(html.includes("break-words"));
});

test("a row of rich objects goes to the table, not to tiles", () => {
  assert.equal(isNumericGroup({ type: "x", labels: { a: 1 } }), false);
  assert.equal(isNumericGroup({ a: 1, b: "2", c: null, d: { e: 3 } }), false);
  assert.equal(isNumericGroup({ a: 1, c: null, d: { e: 3, f: null } }), true);
  assert.equal(isNumericGroup({}), false);
});

test("chart keys come from the union over all rows after expansion", () => {
  const rows = expandObjectColumns([{ t: 1, "a.x": null }, { t: 2, "a.x": { m: 1, n: 2 } }]);
  assert.deepEqual(getMetricKeys(rows), ["t", "a.x.m", "a.x.n"]);
  assert.deepEqual(getMetricKeys([{ t: 1, v: null }, { t: 2, v: null }]), ["t", "v"]);
});

test("copies are dropped from every row of a result, including rows with null members", () => {
  const rows = [
    { o: { count: 1, score: 2 }, count: 1, score: 2 },
    { o: { count: null, score: null }, count: null, score: null },
    { o: { count: null, score: 3 } },
  ];
  assert.deepEqual(dropFlattenedResultCopies(rows).map((r) => Object.keys(r)), [["o"], ["o"], ["o"]]);
});

test("a row that contradicts the copies keeps the whole result", () => {
  const rows = [
    { o: { count: 1, score: 2 }, count: 1, score: 2 },
    { o: { count: 5, score: 6 }, count: 9, score: 6 },
  ];
  assert.equal(dropFlattenedResultCopies(rows), rows);
});

const apdexObj = { count: 676, f: 2, s: 638, score: 0.97, t: 36 };

test("normalizeNewRelicRows puts the apdex score first and keeps the other members in order", () => {
  const [row] = normalizeNewRelicRows([{ "apdex.x": apdexObj }]);
  assert.deepEqual(Object.keys(row["apdex.x"] as object), ["score", "count", "f", "s", "t"]);
  assert.deepEqual(row["apdex.x"], apdexObj);
  const [web] = dropFlattenedRowCopies([{ "apdex.x": apdexObj }], "newrelic") as Record<string, object>[];
  assert.equal(Object.keys(web["apdex.x"])[0], "score");
});

test("normalizeNewRelicRows makes the score of an empty apdex bucket null", () => {
  const [row] = normalizeNewRelicRows([{ "apdex.x": { count: 0, f: 0, s: 0, score: 0, t: 0 } }]);
  assert.equal((row["apdex.x"] as { score: unknown }).score, null);
});

test("normalizeNewRelicRows leaves objects with extra or missing keys, and other objects, alone", () => {
  const rows = [{ a: { ...apdexObj, extra: 1 }, b: { count: 1, f: 0, s: 1, score: 1 }, c: { "95": 1.5 } }];
  assert.equal(normalizeNewRelicRows(rows), rows);
});

test("normalizeNewRelicRows returns the same reference when nothing changes", () => {
  const rows = [{ "apdex.x": { score: 0.97, count: 676, f: 2, s: 638, t: 36 } }, { n: 1 }];
  assert.equal(normalizeNewRelicRows(rows), rows);
});

test("a monitor chart draws only the main member of an object column", () => {
  const rows = [{ t: 1, "apdex.d": { score: 0.9, count: 5 } }, { t: 2, "apdex.d": { score: 0.8, count: 6 } }];
  assert.deepEqual(Object.keys(expandObjectColumns(mainMemberColumns(rows))[0]), ["t", "apdex.d"]);
  assert.equal(expandObjectColumns(mainMemberColumns(rows))[1]["apdex.d"], 0.8);
  assert.deepEqual(Object.keys(expandObjectColumns(rows)[0]), ["t", "apdex.d.score", "apdex.d.count"]);
  const pct = [{ t: 1, p: { "50": 0.4, "99": 2.1 } }];
  assert.equal(mainMemberColumns(pct)[0].p, 2.1);
  assert.equal(mainMemberKey({ "50": 1, "99": 2 }), "99");
  assert.equal(mainMemberKey({ score: 1, count: 2 }), "score");
});

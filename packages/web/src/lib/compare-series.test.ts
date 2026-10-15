import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSeries } from "../components/charts/ChartView";

const WEEK = 7 * 86_400;
const T0 = 1_760_000_000;
const bucket = (i: number) => T0 + i * 300;

// COMPARE WITH 1 week ago TIMESERIES: the previous rows carry the earlier week's own timestamps.
const rows = [0, 1, 2].flatMap((i) => [
  { beginTimeSeconds: bucket(i), endTimeSeconds: bucket(i + 1), count: 100 + i, comparison: "current" },
  { beginTimeSeconds: bucket(i) - WEEK, endTimeSeconds: bucket(i + 1) - WEEK, count: 90 + i, comparison: "previous" },
]);

test("overlays the previous period on the current time axis, dashed, in the same color group", () => {
  const [cur, prev] = compareSeries(rows);
  assert.equal(cur.name, "count");
  assert.equal(prev.name, "count (previous)");
  assert.deepEqual(cur.data.map((p) => p.x), [bucket(0), bucket(1), bucket(2)]);
  assert.deepEqual(prev.data.map((p) => p.x), cur.data.map((p) => p.x));
  assert.deepEqual(prev.data.map((p) => p.y), [90, 91, 92]);
  assert.equal(cur.dashed, false);
  assert.equal(prev.dashed, true);
  assert.equal(cur.group, prev.group);
});

test("keeps timestamps that the server already aligned", () => {
  const aligned = rows.map((r) => ({ ...r, beginTimeSeconds: r.comparison === "previous" ? r.beginTimeSeconds + WEEK : r.beginTimeSeconds }));
  assert.deepEqual(compareSeries(aligned)[1].data.map((p) => p.x), [bucket(0), bucket(1), bucket(2)]);
});

test("builds a current and a previous series per facet value", () => {
  const faceted = rows.flatMap((r) => ["a", "b"].map((f) => ({ ...r, facet: f, count: r.count + (f === "b" ? 1000 : 0) })));
  const series = compareSeries(faceted);
  assert.deepEqual(series.map((s) => s.name), ["a", "a (previous)", "b", "b (previous)"]);
  assert.deepEqual(series.map((s) => s.group), [0, 0, 1, 1]);
  assert.deepEqual(series[3].data.map((p) => p.y), [1090, 1091, 1092]);
  assert.deepEqual(series[3].data.map((p) => p.x), series[2].data.map((p) => p.x));
});

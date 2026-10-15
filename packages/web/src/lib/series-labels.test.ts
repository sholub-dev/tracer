import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSeriesLabels } from "./series-labels";

test("moves the shared dotted prefix out of the labels", () => {
  const names = ["apdex.newrelic.timeslice.value.score", "apdex.newrelic.timeslice.value.t", "apdex.newrelic.timeslice.value.count", "apdex.newrelic.timeslice.value.f", "apdex.newrelic.timeslice.value.s"];
  assert.deepEqual(splitSeriesLabels(names), { prefix: "apdex.newrelic.timeslice.value", labels: ["score", "t", "count", "f", "s"] });
});

test("keeps the comparison suffix on the distinct part", () => {
  assert.deepEqual(splitSeriesLabels(["apdex.x.score", "apdex.x.score (previous)", "apdex.x.t"]), { prefix: "apdex.x", labels: ["score", "score (previous)", "t"] });
});

test("leaves single series and unrelated keys alone", () => {
  assert.deepEqual(splitSeriesLabels(["count"]), { prefix: "", labels: ["count"] });
  assert.deepEqual(splitSeriesLabels(["average.duration", "max.duration"]), { prefix: "", labels: ["average.duration", "max.duration"] });
  assert.deepEqual(splitSeriesLabels(["count", "count (previous)"]), { prefix: "", labels: ["count", "count (previous)"] });
});

test("never empties a label", () => {
  assert.deepEqual(splitSeriesLabels(["a.b", "a.b.c"]), { prefix: "a", labels: ["b", "b.c"] });
});

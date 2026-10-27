import { test } from "node:test";
import assert from "node:assert/strict";
import { periodLabel, pivotCompareWith, readableKey, relativeChange, timelineRows } from "./result-utils";

test("relativeChange shows the signed change from the previous period", () => {
  assert.equal(relativeChange(2786, 15413), "−82%");
  assert.equal(relativeChange(9.73, 1.75), "+456%");
  assert.equal(relativeChange(0.37, 0.39), "−5.1%");
  assert.equal(relativeChange({ 95: 1.1 }, { 95: 1 }), "+10%");
  assert.equal(relativeChange(5, 0), "");
  assert.equal(relativeChange("x", 3), "");
  assert.equal(periodLabel("previous"), "Previous");
});

test("timelineRows charts a date first column with numeric columns only", () => {
  const rows = [{ day: "2026-10-25", n: 3, m: "4" }, { day: "2026-10-26", n: 5, m: null }];
  const out = timelineRows(rows)!;
  assert.equal(out[0].beginTimeSeconds, Date.UTC(2026, 9, 25) / 1000);
  assert.deepEqual(Object.keys(out[1]), ["beginTimeSeconds", "n", "m"]);
  assert.equal(timelineRows([rows[0]]), null);
  assert.equal(timelineRows([{ name: "a", n: 1 }, { name: "b", n: 2 }]), null);
  assert.equal(timelineRows([{ day: "2026-10-25", page: "/x" }, { day: "2026-10-26", page: "/y" }]), null);
  assert.equal(timelineRows([{ beginTimeSeconds: 1, n: 1 }, { beginTimeSeconds: 2, n: 2 }]), null);
});

test("snake_case column names read as words; aliases and NRQL names stay", () => {
  assert.equal(readableKey("users_current"), "Users current");
  assert.equal(readableKey("Error rate (%)"), "Error rate (%)");
  assert.equal(readableKey("average.duration"), "average.duration");
  assert.equal(readableKey("count"), "count");
});

test("timelineRows orders rows by time and COMPARE WITH periods put current first", () => {
  const out = timelineRows([{ day: "2026-10-26", n: 5 }, { day: "2026-10-25", n: 3 }])!;
  assert.deepEqual(out.map((r) => r.n), [3, 5]);
  const { periods } = pivotCompareWith([{ comparison: "previous", n: 1 }, { comparison: "current", n: 2 }]);
  assert.deepEqual(periods, ["current", "previous"]);
});

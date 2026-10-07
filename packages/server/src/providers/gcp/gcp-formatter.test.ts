import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGcpResult } from "./gcp-formatter.js";

const point = (i: number, v: number) => ({ interval: { endTime: `T${String(i).padStart(2, "0")}` }, value: { int64Value: String(v) } });
const series = (name: string, n: number, spike?: number) => ({
  metric: { type: name },
  points: Array.from({ length: n }, (_, i) => point(i, i === spike ? 9999 : 1)),
});

test("downsampled series keeps the spike point", () => {
  const out = formatGcpResult("list_time_series", { timeSeries: [series("m", 30, 13)] });
  assert.ok(out.includes("T13"));
  assert.ok(out.includes("9,999"));
  assert.ok(out.includes("peak and low kept"));
});

test("series beyond the cap are noted", () => {
  const many = Array.from({ length: 30 }, (_, i) => series(`m${i}`, 1));
  const out = formatGcpResult("list_time_series", { timeSeries: many });
  assert.match(out, /\(10 more series omitted\)/);
});

test("a series that does not fit is omitted whole, never cut", () => {
  const out = formatGcpResult("list_time_series", { timeSeries: [series("a", 30), series("b", 30), series("c", 30), series("d", 30, 29)] });
  assert.ok(!out.includes("| d"));
  assert.match(out, /\(1 more series omitted\)/);
});

test("small doubles keep three significant digits", () => {
  const out = formatGcpResult("list_time_series", { timeSeries: [{ metric: { type: "m" }, points: [{ interval: { endTime: "T" }, value: { doubleValue: 0.004 } }] }] });
  assert.ok(out.includes("0.004"));
});

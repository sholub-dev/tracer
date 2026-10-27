import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGcpResult } from "./gcp-formatter.js";

const point = (i: number, v: number) => ({ interval: { endTime: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z` }, value: { int64Value: String(v) } });
const series = (name: string, n: number, spike?: number) => ({
  metric: { type: name },
  points: Array.from({ length: n }, (_, i) => point(i, i === spike ? 9999 : 1)),
});
const tsOf = (v: unknown) => formatGcpResult("list_time_series", v);

test("every point shows up to 400 points, with plain numbers", () => {
  const out = tsOf([series("m", 30, 13)]);
  assert.equal(out.split("\n").filter((l) => l.startsWith("| 2026")).length, 30);
  assert.ok(out.includes("| 9999 |"));
  assert.ok(!out.includes("thinned"));
});

test("above 400 points a series is thinned and keeps its spike", () => {
  const out = tsOf([series("m", 500, 123)]);
  assert.match(out, /thinned/);
  assert.match(out, /of 500 pts/);
  assert.ok(out.includes("9999"));
  assert.ok(out.split("\n").length < 450);
});

test("an int64 beyond 2^53 keeps every digit", () => {
  const out = tsOf([{ metric: { type: "m" }, points: [{ interval: { endTime: "T" }, value: { int64Value: "9007199254740993" } }] }]);
  assert.ok(out.includes("9007199254740993"));
});

test("small doubles keep three significant digits", () => {
  const out = tsOf([{ metric: { type: "m" }, points: [{ interval: { endTime: "T" }, value: { doubleValue: 0.004 } }] }]);
  assert.ok(out.includes("0.004"));
});

test("a distribution prints count, mean and percentiles", () => {
  const dist = { count: "100", mean: 12.5, bucketOptions: { linearBuckets: { numFiniteBuckets: 3, width: 10, offset: 0 } }, bucketCounts: ["0", "50", "40", "10", "0"] };
  const out = tsOf([{ metric: { type: "m" }, points: [{ interval: { endTime: "T" }, value: { distributionValue: dist } }] }]);
  assert.ok(out.includes("count=100 mean=12.5 p50≤10 p95≤30 p99≤30"));
  assert.ok(!out.includes("bucketCounts"));
});

test("series labels show with their keys", () => {
  const out = tsOf([{ metric: { type: "m", labels: { response_code: "500" } }, resource: { labels: { service_name: "api" } }, points: [point(0, 1)] }]);
  assert.ok(out.includes("m {response_code=500 service_name=api}"));
});

test("series that exceed the text budget are cut whole with a count", () => {
  const out = tsOf(Array.from({ length: 60 }, (_, i) => series(`m${"x".repeat(400)}${i}`, 4)));
  assert.match(out, /Showing \d+ of 60 series/);
  assert.ok(out.length < 31_000);
});

test("log rows show trace, span, labels and the exact timestamp", () => {
  const out = formatGcpResult("list_log_entries", [{
    timestamp: "2026-01-01T00:00:00.123456Z", severity: "ERROR", logName: "projects/p/logs/run.googleapis.com%2Fstderr",
    resource: { type: "cloud_run_revision", labels: { service_name: "api", location: "eu" } },
    trace: "projects/p/traces/abc123", spanId: "s1", textPayload: "boom",
  }]);
  assert.ok(out.includes("2026-01-01T00:00:00.123456Z"));
  assert.ok(out.includes("cloud_run_revision service_name=api location=eu"));
  assert.ok(out.includes("| abc123 | s1 | boom |"));
  assert.ok(out.includes("run.googleapis.com/stderr"));
});

test("log messages fall back to protoPayload, httpRequest and the jsonPayload keys", () => {
  const out = formatGcpResult("list_log_entries", [
    { protoPayload: { methodName: "SetIamPolicy", authenticationInfo: { principalEmail: "a@b.c" }, status: { code: 7, message: "denied" } } },
    { httpRequest: { status: 503, requestMethod: "GET", requestUrl: "/x", latency: "1.2s" } },
    { jsonPayload: { code: 5, detail: { a: 1 } } },
  ]);
  assert.ok(out.includes("SetIamPolicy a@b.c 7 denied"));
  assert.ok(out.includes("503 GET /x 1.2s"));
  assert.ok(out.includes('code=5 detail={"a":1}'));
});

test("a log message is capped at 1000 characters with the cut size", () => {
  const out = formatGcpResult("list_log_entries", [{ textPayload: "x".repeat(1500) }]);
  assert.ok(out.includes("… (+500 chars)"));
});

test("log rows show what the API returned and say how many are cut", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, textPayload: "y".repeat(900) }));
  const out = formatGcpResult("list_log_entries", rows);
  const shown = out.split("\n").filter((l) => l.startsWith("| 2026")).length;
  assert.ok(shown > 10 && shown < 50);
  assert.match(out, new RegExp(`Showing ${shown} of 50 entries`));
  assert.match(out, /timestamp < /);
  assert.ok(out.length < 31_000);
});

test("spans use label status, offsets, parent ids and keep the slowest when cut", () => {
  const spans = [
    { spanId: "1", name: "root", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T00:00:01Z", labels: { "/http/status_code": "500" } },
    { spanId: "2", parentSpanId: "1", name: "child", startTime: "2026-01-01T00:00:00.200Z", endTime: "2026-01-01T00:00:00.300Z" },
  ];
  const out = formatGcpResult("get_trace", { traceId: "t", spans });
  assert.ok(out.includes("HTTP 500"));
  assert.ok(out.includes("+200ms"));
  assert.ok(!out.includes("OK"));
  const many = Array.from({ length: 200 }, (_, i) => ({ spanId: String(i), name: `s${i}`, labels: { k: "v".repeat(500) }, startTime: "2026-01-01T00:00:00Z", endTime: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z` }));
  const cut = formatGcpResult("get_trace", { traceId: "t", spans: many });
  assert.match(cut, /Showing \d+ of 200 spans/);
  assert.ok(cut.includes("| s199 |"));
  assert.ok(!cut.includes("| s0 |"));
});

test("trace list shows the full trace id", () => {
  const id = "a".repeat(32);
  const out = formatGcpResult("list_traces", [{ traceId: id, spans: [{ name: "r", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-01T00:00:01Z" }] }]);
  assert.ok(out.includes(id));
  assert.ok(out.includes("1000ms"));
});

test("error groups show the id, users, services and no doubled Z", () => {
  const out = formatGcpResult("list_group_stats", [{
    group: { groupId: "g1" }, representative: { message: "NullPointer" }, count: "42", affectedUsersCount: "7",
    affectedServices: [{ service: "api", version: "v2" }], firstSeenTime: "2026-01-01T00:00:00Z", lastSeenTime: "2026-01-02T00:00:00.5Z",
  }]);
  assert.ok(out.includes("| g1 | NullPointer | 42 | 7 | api@v2 | 2026-01-01 00:00:00Z | 2026-01-02 00:00:00Z |"));
});

test("metric descriptors show kind, type, unit and label keys", () => {
  const out = formatGcpResult("list_metric_descriptors", [{ type: "a/b", displayName: "B", metricKind: "GAUGE", valueType: "INT64", unit: "1", labels: [{ key: "zone" }, { key: "id" }] }]);
  assert.ok(out.includes("| a/b | B | GAUGE | INT64 | 1 | zone, id |"));
});

test("alert policies show condition names and thresholds", () => {
  const out = formatGcpResult("list_alert_policies", [{ displayName: "P", enabled: true, conditions: [{ displayName: "High CPU", conditionThreshold: { comparison: "COMPARISON_GT", thresholdValue: 0.9, duration: "300s" } }] }]);
  assert.ok(out.includes("High CPU (> 0.9 for 300s)"));
});

test("unknown tools are cut at element boundaries with an item count", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ i, pad: "z".repeat(1000) }));
  const out = formatGcpResult("list_alerts", items);
  const m = out.match(/Showing (\d+) of 100 items/);
  assert.ok(m);
  const json = out.slice(out.indexOf("[") , out.lastIndexOf("]") + 1);
  assert.equal(JSON.parse(json).length, Number(m![1]));
  assert.ok(out.length < 31_000);
});

test("a long trace stays within the text budget", () => {
  const spans = Array.from({ length: 600 }, (_, i) => ({ spanId: String(i), name: `s${i}`, labels: { k: "v".repeat(2000) }, startTime: "2026-01-01T00:00:00Z", endTime: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z` }));
  const out = formatGcpResult("get_trace", { traceId: "t", spans });
  assert.match(out, /Showing \d+ of 600 spans/);
  assert.ok(out.length <= 30000 + 500, String(out.length));
});

test("empty generic data and a bad log name do not throw", () => {
  assert.equal(formatGcpResult("other_tool", undefined), "No results.");
  assert.equal(formatGcpResult("other_tool", null), "No results.");
  assert.ok(formatGcpResult("list_log_entries", [{ logName: "projects/p/logs/%E0%A4%A", textPayload: "x", timestamp: "2026-01-01T00:00:00Z" }]).includes("%E0%A4%A"));
});

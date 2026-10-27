import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTimestamps } from "@tracer-sh/shared";
import { formatNrqlCsv, parseFacetNames } from "./nrql-formatter.js";

const facets = (n: number) => Array.from({ length: n }, (_, i) => ({ facet: `f${i}`, count: i + 1 }));

test("a faceted table shows every row within the budget", () => {
  const out = formatNrqlCsv(facets(60));
  assert.equal(out.split("\n").length, 1 + 60);
});

test("a result over the text budget keeps whole rows and says how to see the rest", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ facet: `f${i}`, text: "x".repeat(900) }));
  const out = formatNrqlCsv(rows);
  assert.ok(out.length < 31000);
  assert.match(out, /\(Showing 33 of 100 rows: the rest do not fit the 30000-character result cap\. To see them, narrow the WHERE clause, the window or the LIMIT, or aggregate\.\)$/);
});

test("keyset and SHOW EVENT TYPES results are never cut by rows", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, pad: "x".repeat(900) }));
  assert.equal(formatNrqlCsv(rows, "SELECT keyset() FROM Log").split("\n").length, 101);
  assert.equal(formatNrqlCsv(rows, "SHOW EVENT TYPES").split("\n").length, 101);
});

test("a cell over 1000 characters is cut with a count", () => {
  assert.equal(formatNrqlCsv([{ a: "y".repeat(1005), b: 1 }, { a: "z", b: 2 }]).split("\n")[1], `${"y".repeat(1000)}… (+5 chars),1`);
});

test("columns are the union of keys across rows", () => {
  assert.equal(formatNrqlCsv([{ a: 1 }, { a: 2, b: "x" }, { c: 3 }]), "a,b,c\n1,,\n2,x,\n,,3");
});

test("an attribute named facet or comparison stays in an event list", () => {
  const out = formatNrqlCsv([{ facet: "f1", comparison: "c1", m: 1 }, { facet: "f2", comparison: "c2", m: 2 }], "SELECT facet, comparison, m FROM Log");
  assert.equal(out, "facet,comparison,m\nf1,c1,1\nf2,c2,2");
});

test("null prints as null, a null facet as (none), an empty string stays empty", () => {
  assert.equal(formatNrqlCsv([{ facet: null, c: 1 }, { facet: "a", c: 2 }]), "Name,c\n(none),1\na,2");
  assert.equal(formatNrqlCsv([{ a: null, b: "" }, { a: 1, b: "x" }]), "a,b\nnull,\n1,x");
});

test("arrays print up to 50 items, objects as JSON", () => {
  const out = formatNrqlCsv([{ a: Array.from({ length: 53 }, (_, i) => i), b: 1 }, { a: [{ k: 1 }], b: 2 }]);
  assert.match(out, /49; … \+3 more,1/);
  assert.match(out, /"\{""k"":1\}",2/);
});

test("a multi-attribute facet header comes from the FACET clause", () => {
  const rows = [{ facet: ["a", "b"], count: 1 }, { facet: ["a", null], count: 2 }];
  assert.equal(formatNrqlCsv(rows, "SELECT count(*) FROM T FACET appName, host SINCE 1 hour ago LIMIT 10"), "appName / host,count\na / b,1\na / (none),2");
  assert.equal(formatNrqlCsv(rows), "Name,count\na / b,1\na / (none),2");
});

test("non-integers never round to an integer-looking value", () => {
  assert.equal(formatNrqlCsv([{ a: 0.9996 }]), "a: 0.9996");
  assert.equal(formatNrqlCsv([{ a: 99.996 }]), "a: 99.996");
  assert.equal(formatNrqlCsv([{ a: 3.9 }]), "a: 3.9");
  assert.equal(formatNrqlCsv([{ a: 12345.67 }]), "a: 12345.7");
});

test("a histogram of plain numbers prints bucket indexes", () => {
  assert.equal(formatNrqlCsv([{ "histogram.duration": [5, 0, 2] }]), "Bucket index,Count\n0,5\n1,0\n2,2");
  assert.equal(formatNrqlCsv([{ "histogram.duration": [{ start: 0, count: 4 }] }]), "Bucket,Count\n0,4");
});

test("only keys that name a point in time are converted", () => {
  const ts = 1790229600000;
  const [row] = formatTimestamps(
    [{ timestamp: ts, createdAt: ts, last_at: ts, "latest(timestamp)": ts, "sum(duration)": ts, totalTime: ts, uptime: ts, "average(time)": ts, "count(*)": 5, "request.time": ts }],
    "UTC",
  ) as Record<string, unknown>[];
  for (const k of ["timestamp", "createdAt", "last_at", "latest(timestamp)", "request.time"]) assert.match(String(row[k]), /^2026-/);
  for (const k of ["sum(duration)", "totalTime", "uptime", "average(time)", "count(*)"]) assert.equal(typeof row[k], "number");
});

test("NerdGraph dotted timestamp keys and start/end times are converted", () => {
  const ts = 1790229600000;
  const [row] = formatTimestamps(
    [{ "latest.timestamp": ts, "min.timestamp": ts, startTime: ts, endTime: ts, eventTime: ts, "sum(totalTime)": ts, duration: ts }],
    "UTC",
  ) as Record<string, unknown>[];
  for (const k of ["latest.timestamp", "min.timestamp", "startTime", "endTime", "eventTime"]) assert.match(String(row[k]), /^2026-/);
  for (const k of ["sum(totalTime)", "duration"]) assert.equal(typeof row[k], "number");
});

test("a single row over the budget is cut with a note", () => {
  const out = formatNrqlCsv([Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, "x".repeat(900)]))], "SELECT * FROM Log");
  assert.ok(out.includes("(Row cut at 30000 characters; select fewer columns.)"));
  assert.ok(out.length <= 30000 + 100);
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

test("raw events at 100 rows get the not-a-total note and no row cut", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ message: `m${i}` }));
  const out = formatNrqlCsv(rows, "SELECT message FROM Log");
  assert.equal(out.split("\n").length, 1 + 100 + 1);
  assert.match(out, /row limit of 100; there can be more\. This is not a total\.\)$/);
});

const series = (n: number, v: (i: number) => unknown) =>
  Array.from({ length: n }, (_, i) => ({ beginTimeSeconds: `t${String(i).padStart(3, "0")}`, endTimeSeconds: i, v: v(i) }));

test("a timeseries up to 400 points shows every bucket by its start", () => {
  const out = formatNrqlCsv(series(400, (i) => i));
  assert.equal(out.split("\n").length, 401);
  assert.ok(out.startsWith("Bucket start,v\nt000,0\n"));
});

test("a thinned timeseries keeps first, last, peak, low and gap buckets in time order", () => {
  const out = formatNrqlCsv(series(1000, (i) => (i === 313 ? 1000 : i === 727 ? -5 : i === 501 ? null : 10)));
  for (const t of ["t000,", "t999,", "t313,1000", "t727,-5", "t501,null"]) assert.ok(out.includes(t), t);
  assert.ok(out.indexOf("t313,") < out.indexOf("t727,"));
  assert.match(out, /\(Showing \d+ of 1000 buckets: about 1 in 3 points, .*Query a narrower window to see every bucket\.\)$/);
});

test("a thinned timeseries keeps the peak of object members", () => {
  const out = formatNrqlCsv(series(1000, (i) => ({ score: i === 613 ? 0.2 : 0.9 })));
  assert.ok(out.includes("t613,"));
});

test("small non-integers keep four significant digits", () => {
  assert.equal(formatNrqlCsv([{ a: 0.004 }]), "a: 0.004");
  assert.equal(formatNrqlCsv([{ a: 0 }]), "a: 0");
  assert.equal(formatNrqlCsv([{ a: 1.234 }]), "a: 1.234");
});

test("faceted timeseries groups rows under a heading per series", () => {
  const rows = ["a", "b"].flatMap((app) => [0, 1].map((i) => ({ beginTimeSeconds: `t${i}`, endTimeSeconds: i, facet: app, appName: app, count: i })));
  assert.equal(formatNrqlCsv(rows), "Bucket start,count\nappName: a\nt0,0\nt1,1\nappName: b\nt0,0\nt1,1");
});

const at = (h: number, m: number, sec: number, day = 19) => `2026-10-${day} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")} PDT`;
const ts = (starts: string[], v: (i: number) => unknown, extra: (i: number) => Record<string, unknown> = () => ({})) =>
  starts.map((b, i) => ({ beginTimeSeconds: b, endTimeSeconds: i, v: v(i), ...extra(i) }));

test("an unfaceted timeseries shows HH:MM under a date line, with a legend", () => {
  const out = formatNrqlCsv(ts([at(23, 58, 20), at(23, 59, 20), at(0, 0, 20, 20)], (i) => i));
  assert.equal(out, "Bucket start,v\n2026-10-19\n23:58,0\n23:59,1\n2026-10-20\n00:00,2\n(Bucket starts in PDT, seconds :20; a date line starts each day.)");
});

test("seconds stay when they differ", () => {
  const out = formatNrqlCsv(ts([at(1, 0, 20), at(1, 1, 21)], (i) => i));
  assert.equal(out, "Bucket start,v\n2026-10-19\n01:00:20,0\n01:01:21,1\n(Bucket starts in PDT; a date line starts each day.)");
});

test("a faceted timeseries drops the facet column and merges a run", () => {
  const starts = [at(12, 0, 20), at(12, 1, 20), at(12, 2, 20), at(12, 3, 20)];
  const rows = [
    ...ts(starts, (i) => (i === 3 ? 5 : 0), () => ({ facet: "web" })),
    ...ts(starts.slice(0, 2), (i) => i, () => ({ facet: "api" })),
  ];
  const out = formatNrqlCsv(rows, "SELECT count(*) FROM T FACET name TIMESERIES");
  assert.equal(
    out.split("\n").slice(0, 8).join("\n"),
    "Bucket start,v\nname: web\n2026-10-19\n12:00-12:02 (3 buckets),0\n12:03,5\nname: api\n2026-10-19\n12:00,0",
  );
  assert.match(out, /a row 'A-B \(N buckets\)' stands for N buckets in a row with the same values\.\)$/);
});

test("a partial bucket is never merged", () => {
  const out = formatNrqlCsv(ts([at(1, 0, 20), at(1, 1, 20), `${at(1, 2, 20)} (partial)`], () => 0));
  assert.ok(out.includes("01:00,0\n01:01,0\n01:02 (partial),0"));
  assert.ok(!out.includes("buckets"));
});

test("a thinned timeseries is not merged", () => {
  const starts = Array.from({ length: 1000 }, (_, i) => at(Math.floor(i / 60) % 24, i % 60, 20));
  const out = formatNrqlCsv(ts(starts, () => 0));
  assert.ok(out.includes("(Showing "));
  assert.ok(!out.includes("(N buckets)") && !/\d buckets\)/.test(out));
});

test("unparsable bucket starts keep the full cells", () => {
  const out = formatNrqlCsv(ts([at(1, 0, 20), "soon"], (i) => i));
  assert.equal(out, `Bucket start,v\n${at(1, 0, 20)},0\nsoon,1`);
});

test("the result cap counts printed rows of a timeseries", () => {
  const starts = Array.from({ length: 400 }, (_, i) => at(Math.floor(i / 60), i % 60, 20));
  const out = formatNrqlCsv(ts(starts, (i) => "x".repeat(150) + i));
  assert.ok(out.length < 30400);
  assert.match(out, /\(Showing (\d+) of 400 rows: the rest do not fit the 30000-character result cap\./);
});

test("the word limit inside a string literal is not a LIMIT clause", () => {
  assert.ok(formatNrqlCsv(facets(10), "SELECT count(*) FROM Transaction WHERE request.uri LIKE '%rate-limit%' FACET name").includes("row limit of 10"));
});

test("a timeseries with COMPARE WITH labels each period", () => {
  const rows = [0, 1].flatMap((i) => [
    { beginTimeSeconds: `t${i}`, count: 10 + i, comparison: "current" },
    { beginTimeSeconds: `p${i}`, count: 5 + i, comparison: "previous" },
  ]);
  assert.equal(formatNrqlCsv(rows), "current:\nBucket start,count\nt0,10\nt1,11\n\nprevious:\nBucket start,count\np0,5\np1,6");
});

test("a metric that equals the facet value in the first row only stays visible", () => {
  const rows = [
    { facet: 200, httpResponseCode: 200, count: 200 },
    { facet: 500, httpResponseCode: 500, count: 7 },
  ];
  assert.equal(formatNrqlCsv(rows), "httpResponseCode,count\n200,200\n500,7");
});

test("a faceted comparison finds the periods by label, whatever the row order", () => {
  const out = formatNrqlCsv([
    { facet: "a", appName: "a", "average.duration": 1.1, comparison: "previous" },
    { facet: "b", appName: "b", "average.duration": 0, comparison: "previous" },
    { facet: "a", appName: "a", "average.duration": 3.9, comparison: "current" },
    { facet: "b", appName: "b", "average.duration": 0.5, comparison: "current" },
  ]);
  assert.equal(out, "appName,current,previous,change\na,3.9,1.1,+2.8 (x3.545)\nb,0.5,0,+0.5");
});

test("a scalar comparison shows the change, also for object members", () => {
  assert.equal(
    formatNrqlCsv([{ count: 10, comparison: "previous" }, { count: 15, comparison: "current" }]),
    "count (current): 15, count (previous): 10, count (change): +5 (x1.5)",
  );
  const out = formatNrqlCsv([
    { p: { 50: 2, 95: 8 }, comparison: "current" },
    { p: { 50: 1, 95: 4 }, comparison: "previous" },
  ]);
  assert.match(out, /p \(change\): 50: \+1 \(x2\); 95: \+4 \(x2\)$/);
});

test("a faceted comparison gets the limit note on distinct facets", () => {
  const rows = Array.from({ length: 10 }, (_, i) => i).flatMap((i) => ["current", "previous"].map((comparison) => ({ facet: `f${i}`, c: i, comparison })));
  assert.ok(formatNrqlCsv(rows, "SELECT count(*) FROM T FACET name COMPARE WITH 1 day ago").includes("row limit of 10"));
});

test("a faceted timeseries gets the limit note on distinct series", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ beginTimeSeconds: "t0", facet: `f${i}`, c: i }));
  assert.ok(formatNrqlCsv(rows, "SELECT count(*) FROM T FACET name TIMESERIES").includes("row limit of 10"));
});

test("a faceted timeseries keeps the peak of each series", () => {
  const rows = ["a", "b"].flatMap((f) => Array.from({ length: 500 }, (_, i) => ({
    beginTimeSeconds: `t${i}`, facet: f, appName: f, count: f === "b" && i === 437 ? 999 : 1,
  })));
  const out = formatNrqlCsv(rows);
  assert.match(out, /appName: b\n[\s\S]*t437,999/);
  assert.match(out, /about 1 in 3 points per series/);
});

test("FACET names end at a top-level clause, not at one inside parentheses", () => {
  assert.deepEqual(parseFacetNames("SELECT count(*) FROM Span FACET host WHERE name = 'a'"), ["host"]);
  assert.notDeepEqual(parseFacetNames("SELECT count(*) FROM Transaction FACET cases(WHERE duration > 1 AS 'slow') SINCE 1 hour ago"), ["cases("]);
});

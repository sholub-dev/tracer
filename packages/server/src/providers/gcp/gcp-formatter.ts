// ── Limits ──

/** One text budget per result. */
const TEXT_BUDGET = 30_000;
/** Cap for one cell or message. */
const CELL_CAP = 1000;
/** Points shown whole per result; above this, series are thinned. */
const MAX_POINTS = 400;

// ── Helpers ──

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function clip(s: string, max = CELL_CAP): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max} chars)` : s;
}

// toFixed(2) would turn 0.004 into "0.00"
const smallOrFixed = (n: number) => Math.abs(n) < 1 ? Number(n.toPrecision(3)).toString() : Number(n.toFixed(2)).toString();

const fmtNum = (n: number) => Number.isInteger(n) ? String(n) : smallOrFixed(n);

/** Plain numbers only; an int64 string beyond 2^53 stays a string so no digits are lost. */
function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (v.trim() !== "" && Number.isFinite(n)) return Number.isSafeInteger(n) || !/^-?\d+$/.test(v.trim()) ? fmtNum(n) : v.trim();
    return v;
  }
  if (Array.isArray(v)) return v.length <= 3 ? v.join(", ") : `[${v.length} items]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const kv = (o: unknown): string =>
  isObj(o) ? Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ") : "";

const mdRow = (r: string[]) =>
  `| ${r.map((c) => clip(String(c)).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;

const mdHead = (headers: string[]) => `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;

/** How many leading groups of rows fit the text budget. At least one is always kept. */
function fitCount(headers: string[], groups: string[][][]): number {
  let used = mdHead(headers).length + 300;
  let n = 0;
  for (const g of groups) {
    used += g.reduce((s, r) => s + mdRow(r).length + 1, 0);
    if (used > TEXT_BUDGET && n > 0) break;
    n++;
  }
  return n;
}

const mdTable = (headers: string[], rows: string[][]) =>
  rows.length === 0 ? "(empty)" : `${mdHead(headers)}\n${rows.map(mdRow).join("\n")}`;

const cutNote = (shown: number, total: number, label: string, hint: string) =>
  shown < total ? `\n\n*Showing ${shown} of ${total} ${label}: the rest do not fit the result cap. ${hint}*` : "";

const NARROW = "Narrow the filter or the time range, or lower pageSize, to see the rest.";

/** One row per item, cut at the text budget. */
function itemTable(headers: string[], rows: string[][], label: string, hint = NARROW): string {
  if (rows.length === 0) return "(empty)";
  const n = fitCount(headers, rows.map((r) => [r]));
  return mdTable(headers, rows.slice(0, n)) + cutNote(n, rows.length, label, hint);
}

/** Unwrap GCP API envelope shapes — handles arrays, { logEntries: [...] }, etc. */
function toArray(data: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (isObj(data)) {
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k] as unknown[];
    }
  }
  return [];
}

const ts = (v: unknown) => typeof v === "string" ? v.replace("T", " ").replace(/(\.\d+)?Z$/, "Z") : "—";

// ── Logs ──

function httpSummary(h: unknown): string {
  if (!isObj(h)) return "";
  return [h.status, h.requestMethod, h.requestUrl, h.latency].filter((x) => x != null && x !== "").join(" ");
}

function protoSummary(p: unknown): string {
  if (!isObj(p)) return "";
  const who = isObj(p.authenticationInfo) ? p.authenticationInfo.principalEmail : undefined;
  const st = isObj(p.status) ? `${p.status.code ?? ""} ${p.status.message ?? ""}`.trim() : "";
  return [p.methodName, who, st].filter((x) => x != null && x !== "").join(" ");
}

/** Extract a human-readable message from a log entry's payload. */
function extractLogMessage(entry: Obj): string {
  if (typeof entry.textPayload === "string") return entry.textPayload;
  const jp = isObj(entry.jsonPayload) ? entry.jsonPayload : undefined;
  if (jp) {
    for (const k of ["message", "msg", "error", "text"]) {
      if (typeof jp[k] === "string") return jp[k] as string;
    }
  }
  const proto = protoSummary(entry.protoPayload);
  if (proto) return proto;
  const http = httpSummary(entry.httpRequest);
  if (http) return http;
  if (jp) return kv(jp) || "—";
  return "—";
}

function formatLogEntries(data: unknown): string {
  const entries = toArray(data, "logEntries", "entries");
  if (entries.length === 0) return "No log entries found.";

  const rows = entries.map((e) => {
    const entry = (isObj(e) ? e : {}) as Obj;
    // The timestamp stays exact: the next page filters on it.
    const time = typeof entry.timestamp === "string" ? entry.timestamp : "—";
    const resource = isObj(entry.resource) ? entry.resource : undefined;
    const res = resource ? [resource.type, kv(resource.labels)].filter(Boolean).join(" ") : "—";
    const trace = typeof entry.trace === "string" ? entry.trace.split("/traces/").pop()! : "—";
    const logName = typeof entry.logName === "string" ? safeDecode(entry.logName.split("/logs/").pop()!) : "—";
    return [time, String(entry.severity ?? "DEFAULT"), res, logName, trace, String(entry.spanId ?? "—"), extractLogMessage(entry)];
  });

  return itemTable(
    ["Timestamp", "Severity", "Resource", "Log", "Trace", "Span", "Message"],
    rows,
    "entries",
    'To see older entries, repeat the call with orderBy "timestamp desc" and add `timestamp < "<oldest Timestamp shown>"` to the filter, or narrow the filter.',
  );
}

// ── Time series ──

type Bucketed = { upper: (i: number) => number };

function bucketBounds(opts: unknown): Bucketed | undefined {
  if (!isObj(opts)) return undefined;
  const exp = opts.exponentialBuckets, lin = opts.linearBuckets, ex = opts.explicitBuckets;
  if (isObj(exp)) {
    const n = Number(exp.numFiniteBuckets), g = Number(exp.growthFactor), s = Number(exp.scale);
    return { upper: (i) => i <= n ? s * g ** i : Infinity };
  }
  if (isObj(lin)) {
    const n = Number(lin.numFiniteBuckets), w = Number(lin.width), o = Number(lin.offset ?? 0);
    return { upper: (i) => i <= n ? o + w * i : Infinity };
  }
  if (isObj(ex) && Array.isArray(ex.bounds)) {
    const b = ex.bounds as number[];
    return { upper: (i) => i < b.length ? Number(b[i]) : Infinity };
  }
  return undefined;
}

function fmtDistribution(d: Obj): string {
  const count = Number(d.count ?? 0);
  const parts = [`count=${fmtVal(d.count ?? 0)}`];
  if (d.mean != null) parts.push(`mean=${fmtVal(d.mean)}`);
  const bounds = bucketBounds(d.bucketOptions);
  const counts = Array.isArray(d.bucketCounts) ? d.bucketCounts.map(Number) : [];
  if (bounds && counts.length > 0 && count > 0) {
    for (const p of [50, 95, 99]) {
      let acc = 0;
      const i = counts.findIndex((c) => (acc += c) >= (p / 100) * count);
      if (i >= 0) {
        const u = bounds.upper(i);
        if (Number.isFinite(u)) parts.push(`p${p}≤${fmtNum(Number(u.toPrecision(4)))}`);
        // An unbounded first bucket has no lower bound to report.
        else if (i > 0) parts.push(`p${p}>${fmtNum(Number(bounds.upper(i - 1).toPrecision(4)))}`);
      }
    }
  }
  return parts.join(" ");
}

function fmtPointValue(value: unknown): string {
  if (!isObj(value)) return "—";
  if (isObj(value.distributionValue)) return fmtDistribution(value.distributionValue);
  const v = value.int64Value ?? value.doubleValue ?? value.boolValue ?? value.stringValue;
  return v == null ? JSON.stringify(value) : fmtVal(v);
}

const pointTime = (p: Obj) => {
  const iv = isObj(p.interval) ? p.interval : undefined;
  return String(iv?.endTime ?? iv?.startTime ?? "—");
};

/** Keeps first, last, peak, low and the edges of gaps, then spreads the rest evenly up to `limit`. */
function thinPoints(points: Obj[], limit: number): Obj[] {
  const keep = new Set<number>([0, points.length - 1]);
  const nums = points.map((p) => {
    const n = isObj(p.value) ? Number(p.value.int64Value ?? p.value.doubleValue) : NaN;
    return Number.isFinite(n) ? n : null;
  });
  let max = -1, min = -1;
  nums.forEach((n, i) => {
    if (n === null) return;
    if (max < 0 || n > nums[max]!) max = i;
    if (min < 0 || n < nums[min]!) min = i;
  });
  if (max >= 0) keep.add(max);
  if (min >= 0) keep.add(min);
  const times = points.map((p) => Date.parse(pointTime(p)));
  const steps = times.slice(1).map((t, i) => Math.abs(times[i]! - t)).filter(Number.isFinite).sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  if (median) {
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(times[i - 1]! - times[i]!) > 2 * median) { keep.add(i - 1); keep.add(i); }
    }
  }
  const spare = limit - keep.size;
  if (spare > 0) {
    const step = points.length / (spare + 1);
    for (let k = 1; k <= spare; k++) keep.add(Math.min(points.length - 1, Math.floor(k * step)));
  }
  return points.filter((_, i) => keep.has(i));
}

function formatTimeSeries(data: unknown): string {
  const series = toArray(data, "timeSeries");
  if (series.length === 0) return "No time series data found.";

  const total = series.reduce<number>((s, t) => s + Math.max(1, isObj(t) && Array.isArray(t.points) ? t.points.length : 0), 0);
  const perSeries = total > MAX_POINTS ? Math.max(4, Math.floor(MAX_POINTS / series.length)) : Infinity;
  let thinned = false;

  const groups: string[][][] = series.map((s) => {
    const t = (isObj(s) ? s : {}) as Obj;
    const metric = isObj(t.metric) ? t.metric : {};
    const resource = isObj(t.resource) ? t.resource : {};
    const labels = [kv(metric.labels), kv(resource.labels)].filter(Boolean).join(" ");
    const name = `${metric.type ?? "—"}${labels ? ` {${labels}}` : ""}`;
    const points = Array.isArray(t.points) ? (t.points as Obj[]) : [];
    if (points.length === 0) return [["—", name, "no data"]];
    let shown = points;
    if (points.length > perSeries) {
      shown = thinPoints(points, perSeries);
      thinned = true;
    }
    const tag = shown.length < points.length ? ` (${shown.length} of ${points.length} pts)` : "";
    return shown.map((p) => [pointTime(p), name + tag, fmtPointValue(p.value)]);
  });

  const headers = ["Time", "Series", "Value"];
  // A series is shown whole or not at all.
  const n = fitCount(headers, groups);
  const rows = groups.slice(0, n).flat();
  const notes = [
    thinned ? `\n\n*More than ${MAX_POINTS} points: each series is thinned. First, last, peak, low and gap points are kept. Narrow the time range or use a coarser alignmentPeriod to see all points.*` : "",
    cutNote(n, series.length, "series", "Narrow the filter or lower pageSize to see the rest."),
  ].join("");
  return mdTable(headers, rows) + notes;
}

// ── Traces ──

const spanName = (s: Obj) => String(s.displayName ?? s.name ?? "—");
const spanMs = (s: Obj, k: "startTime" | "endTime") => s[k] ? Date.parse(String(s[k])) : NaN;
const spanDur = (s: Obj) => spanMs(s, "endTime") - spanMs(s, "startTime");
const fmtDur = (ms: number) => Number.isNaN(ms) ? "—" : `${ms}ms`;

/** There is no span status field in the Trace v1 API; read it from the labels. */
function spanStatus(s: Obj): string {
  const labels = isObj(s.labels) ? (s.labels as Record<string, string>) : {};
  const parts: string[] = [];
  const code = labels["/http/status_code"] ?? labels["http.status_code"];
  if (code) parts.push(`HTTP ${code}`);
  for (const [k, v] of Object.entries(labels)) {
    if (/error/i.test(k) && k !== "/http/status_code") parts.push(`${k}=${v}`);
  }
  return parts.join(" ") || "—";
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function formatSpans(spans: unknown[]): string {
  if (spans.length === 0) return "(no spans)";
  const list = spans.map((s) => (isObj(s) ? s : {}) as Obj);
  const t0 = Math.min(...list.map((s) => spanMs(s, "startTime")).filter((n) => !Number.isNaN(n)));

  const headers = ["Span", "Span ID", "Parent", "Start", "Duration", "Status", "Labels"];
  const rowOf = (s: Obj) => {
    const start = spanMs(s, "startTime");
    return [spanName(s), String(s.spanId ?? "—"), String(s.parentSpanId ?? "—"), Number.isNaN(start) || !Number.isFinite(t0) ? "—" : `+${start - t0}ms`, fmtDur(spanDur(s)), spanStatus(s), kv(s.labels) || "—"];
  };
  const rows = list.map(rowOf);
  // When cutting, the slowest spans stay, shown in start order.
  const slowest = rows.map((_, i) => i).sort((a, b) => (spanDur(list[b]!) || 0) - (spanDur(list[a]!) || 0));
  const n = fitCount(headers, slowest.map((i) => [rows[i]!]));
  if (n === rows.length) return mdTable(headers, rows);
  const keep = new Set(slowest.slice(0, n));
  return mdTable(headers, rows.filter((_, i) => keep.has(i))) + cutNote(n, rows.length, "spans", "The longest spans are shown. Use the Span ID and Parent columns to follow one branch, or open another trace.");
}

function formatTraces(data: unknown): string {
  const traces = toArray(data, "traces");
  if (traces.length === 0) return "No traces found.";

  const rows = traces.map((t) => {
    const trace = (isObj(t) ? t : {}) as Obj;
    const spans = Array.isArray(trace.spans) ? (trace.spans as Obj[]) : [];
    const root = spans[0];
    return [
      String(trace.traceId ?? "—"),
      root ? spanName(root) : "—",
      root ? ts(root.startTime) : "—",
      root ? fmtDur(spanDur(root)) : "—",
      root ? spanStatus(root) : "—",
    ];
  });

  return itemTable(["Trace ID", "Root Span", "Start", "Duration", "Status"], rows, "traces");
}

function formatTrace(data: unknown): string {
  if (!isObj(data)) return "No trace data.";
  const spans = Array.isArray(data.spans) ? (data.spans as unknown[]) : [];
  return `**Trace:** ${String(data.traceId ?? "—")}\n\n${formatSpans(spans)}`;
}

// ── Error Reporting, metrics, alerts ──

function formatErrorGroups(data: unknown): string {
  const groups = toArray(data, "errorGroupStats", "groups");
  if (groups.length === 0) return "No error groups found.";

  const rows = groups.map((g) => {
    const group = (isObj(g) ? g : {}) as Obj;
    const info = isObj(group.group) ? group.group : undefined;
    const rep = isObj(group.representative) ? group.representative : undefined;
    const title = info?.title ?? rep?.message ?? "—";
    const services = Array.isArray(group.affectedServices)
      ? group.affectedServices.map((s) => isObj(s) ? [s.service, s.version].filter(Boolean).join("@") : String(s)).join(", ")
      : "";
    return [
      String(info?.groupId ?? "—"),
      String(title),
      fmtVal(group.count),
      fmtVal(group.affectedUsersCount),
      services || fmtVal(group.numAffectedServices),
      ts(group.firstSeenTime),
      ts(group.lastSeenTime),
    ];
  });

  return itemTable(["Group ID", "Error", "Count", "Users", "Services", "First Seen", "Last Seen"], rows, "error groups");
}

function formatMetricDescriptors(data: unknown): string {
  const descriptors = toArray(data, "metricDescriptors");
  if (descriptors.length === 0) return "No metric descriptors found.";

  const rows = descriptors.map((d) => {
    const desc = (isObj(d) ? d : {}) as Obj;
    const labelKeys = Array.isArray(desc.labels) ? desc.labels.map((l) => isObj(l) ? String(l.key) : String(l)).join(", ") : "";
    return [
      String(desc.type ?? desc.name ?? "—"),
      String(desc.displayName ?? "—"),
      String(desc.metricKind ?? "—"),
      String(desc.valueType ?? "—"),
      String(desc.unit ?? "—"),
      labelKeys || "—",
    ];
  });

  return itemTable(["Metric Type", "Display Name", "Kind", "Value Type", "Unit", "Labels"], rows, "descriptors");
}

const COMPARISON: Record<string, string> = {
  COMPARISON_GT: ">", COMPARISON_GE: ">=", COMPARISON_LT: "<", COMPARISON_LE: "<=", COMPARISON_EQ: "=", COMPARISON_NE: "!=",
};

function describeCondition(c: unknown): string {
  if (!isObj(c)) return String(c);
  const name = String(c.displayName ?? "condition");
  const th = isObj(c.conditionThreshold) ? c.conditionThreshold : undefined;
  if (!th) return isObj(c.conditionAbsent) ? `${name} (absent for ${c.conditionAbsent.duration ?? "?"})` : name;
  const cmp = COMPARISON[String(th.comparison)] ?? String(th.comparison ?? "");
  const dur = th.duration && th.duration !== "0s" ? ` for ${th.duration}` : "";
  return th.thresholdValue != null ? `${name} (${cmp} ${fmtVal(th.thresholdValue)}${dur})` : name;
}

function formatAlertPolicies(data: unknown): string {
  const policies = toArray(data, "alertPolicies");
  if (policies.length === 0) return "No alert policies found.";

  const rows = policies.map((p) => {
    const policy = (isObj(p) ? p : {}) as Obj;
    const enabled = policy.enabled === true ? "yes" : policy.enabled === false ? "no" : "—";
    const conditions = Array.isArray(policy.conditions) ? policy.conditions.map(describeCondition).join("; ") : "—";
    return [String(policy.displayName ?? policy.name ?? "—"), enabled, conditions];
  });

  return itemTable(["Policy", "Enabled", "Conditions"], rows, "policies");
}

/** Other tools: whole elements up to the text budget, never a cut inside one. */
function formatGeneric(data: unknown): string {
  if (data == null) return "No results.";
  const wrap = (s: string) => "```json\n" + s + "\n```";
  if (!Array.isArray(data)) {
    const json = typeof data === "string" ? data : JSON.stringify(data);
    if (json.length <= TEXT_BUDGET) return wrap(json);
    return wrap(json.slice(0, TEXT_BUDGET)) + `\n\n*Cut after ${TEXT_BUDGET} of ${json.length} characters: the result cap. ${NARROW}*`;
  }
  const items = data.map((d) => JSON.stringify(d));
  let used = 2;
  let n = 0;
  for (const it of items) {
    used += it.length + 1;
    if (used > TEXT_BUDGET - 300 && n > 0) break;
    n++;
  }
  const body = n === 1 && items[0]!.length > TEXT_BUDGET ? items[0]!.slice(0, TEXT_BUDGET) : items.slice(0, n).join(",");
  return wrap(`[${body}]`) + cutNote(n, items.length, "items", NARROW);
}

// ── Main entry point ──

export function formatGcpResult(toolName: string, data: unknown): string {
  switch (toolName) {
    case "list_log_entries":
      return formatLogEntries(data);
    case "list_time_series":
      return formatTimeSeries(data);
    case "list_traces":
      return formatTraces(data);
    case "get_trace":
      return formatTrace(data);
    case "list_group_stats":
      return formatErrorGroups(data);
    case "list_metric_descriptors":
      return formatMetricDescriptors(data);
    case "list_alert_policies":
      return formatAlertPolicies(data);
    default:
      return formatGeneric(data);
  }
}

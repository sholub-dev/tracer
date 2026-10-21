// ── HogQL response → row objects + token-efficient CSV (for the LLM) ──

import type { HogQLQueryResponse } from "./types.js";

/** Suffix repeated column names (`count()`, `count()` -> `count()`, `count()_2`) so no column overwrites another. */
function uniqueNames(columns: string[]): string[] {
  const seen = new Map<string, number>();
  const used = new Set(columns);
  return columns.map((col) => {
    const n = (seen.get(col) ?? 0) + 1;
    seen.set(col, n);
    if (n === 1) return col;
    let name = `${col}_${n}`;
    for (let k = n; used.has(name); k++) name = `${col}_${k + 1}`;
    used.add(name);
    return name;
  });
}

/** Zip the columnar Query API response into row objects keyed by column name. */
export function rowsToObjects(resp: HogQLQueryResponse): Record<string, unknown>[] {
  const { columns, results } = resp;
  if (!Array.isArray(results) || !Array.isArray(columns)) return [];
  const names = uniqueNames(columns);
  return results.map((row) => {
    const obj: Record<string, unknown> = {};
    names.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

// ── Timeseries shaping: make time-bucketed HogQL results chart like New Relic ──
//
// New Relic's TIMESERIES results carry a numeric `beginTimeSeconds` per row, which the web
// auto-detects and plots. HogQL has no TIMESERIES clause: a `GROUP BY toStartOf*(timestamp)`
// returns the bucket as a DateTime *string* column, so those results fell through to a flat table.
// `toChartRows` reshapes them into the exact row contract New Relic emits — a numeric
// `beginTimeSeconds` plus the metric columns (and an optional `facet`) — so the existing web
// chart (and table) rendering picks them up identically, with no duplicated charting logic.

/** ClickHouse Date / DateTime string, e.g. "2024-01-15" or "2024-01-15 14:00:00(.sss)(Z|+00:00)". */
const CH_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse a ClickHouse Date/DateTime string to Unix seconds (CH datetimes are naive UTC). */
function timeValueToUnixSeconds(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!CH_DATETIME_RE.test(trimmed)) return null;
  // Pin naive "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DD" values to UTC before parsing.
  const s = /[TZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ? trimmed
    : (trimmed.includes(" ") ? trimmed.replace(" ", "T") : `${trimmed}T00:00:00`) + "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** A finite number, or a plain decimal string (HogQL may serialize counts/aggregates as strings). */
export function isNumericValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return /^-?\d+(\.\d+)?$/.test(v.trim());
  return false;
}

/**
 * Reshape time-bucketed HogQL rows into New Relic's chartable row contract so the existing web
 * timeseries chart renders them. Returns the rows unchanged when they don't look like a
 * time-series aggregation (raw event scans, single-value/scalar results, multi-dimension pivots),
 * leaving those to render as tables/badges exactly as before.
 */
export function toChartRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length < 2) return rows;
  const cols = Object.keys(rows[0]);

  // Time column: every value parses to a Unix second (the GROUP BY bucket). Requiring a successful
  // parse — not just a regex shape match — guarantees the injected `beginTimeSeconds` is never null.
  const timeCol = cols.find((c) =>
    rows.every((r) => typeof r[c] === "string" && timeValueToUnixSeconds(r[c]) !== null),
  );
  if (!timeCol) return rows;

  const others = cols.filter((c) => c !== timeCol);
  // Metrics: numeric series to plot. Dimensions: any other column that actually carries a value.
  const metrics = others.filter(
    (c) => rows.some((r) => r[c] != null) && rows.every((r) => r[c] == null || isNumericValue(r[c])),
  );
  if (metrics.length === 0) return rows; // nothing numeric to plot → leave as a table
  const dims = others.filter((c) => !metrics.includes(c) && rows.some((r) => r[c] != null));
  if (dims.length > 1) return rows; // more than one breakdown → a table is clearer than a chart
  const dimCol = dims[0];

  return rows.map((r) => {
    const out: Record<string, unknown> = { beginTimeSeconds: timeValueToUnixSeconds(r[timeCol]) };
    // Coerce to a real number: the web chart's coerceNumeric ignores numeric strings (which HogQL
    // may return for counts/aggregates) and would otherwise plot an empty line.
    for (const m of metrics) out[m] = r[m] == null ? null : Number(r[m]);
    if (dimCol !== undefined) {
      out[dimCol] = r[dimCol]; // keep the named breakdown so its real label survives in the chart
      out.facet = r[dimCol]; // mirror it into `facet` so the existing faceted chart picks it up
    }
    return out;
  });
}

// Cap what reaches the MODEL: tool results are re-sent on every later step, so the cost compounds.
// The UI still gets the full untruncated rows via the query `parts`.
const MAX_CELL_CHARS = 1000;
const MAX_ARRAY_ITEMS = 50;
/** Text budget for one result, in characters. */
const MAX_RESULT_CHARS = 30_000;

function capCell(s: string): string {
  return s.length <= MAX_CELL_CHARS ? s : `${s.slice(0, MAX_CELL_CHARS)}… (+${s.length - MAX_CELL_CHARS} chars)`;
}

function fmtVal(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : Math.abs(v) < 1 ? Number(v.toPrecision(3)).toString() : v.toFixed(2);
  if (Array.isArray(v)) {
    const items = v.slice(0, MAX_ARRAY_ITEMS).map((x) => (x !== null && typeof x === "object" ? JSON.stringify(x) : String(x)));
    const more = v.length > MAX_ARRAY_ITEMS ? `; … +${v.length - MAX_ARRAY_ITEMS} more` : "";
    return capCell(items.join("; ") + more);
  }
  if (typeof v === "object") return capCell(JSON.stringify(v));
  const s = String(v);
  // HogQL returns a `properties` map as a JSON string: show it compact.
  if (/^\s*[{[]/.test(s)) {
    try {
      const parsed: unknown = JSON.parse(s);
      // Strip whitespace outside strings only: reparsing would round integers above 2^53.
      if (parsed !== null && typeof parsed === "object") return capCell(s.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (m) => (m[0] === '"' ? m : "")));
    } catch { /* not JSON: print as text */ }
  }
  return capCell(s);
}

/** Escape a value for CSV: quote if it contains commas, quotes, or newlines. */
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/** What the HogQL API returns when a query has no LIMIT clause. */
const DEFAULT_LIMIT = 100;

/** The row limit of the outermost query: skips string literals and anything inside parentheses. */
function outerLimit(query: string): number | null {
  let depth = 0;
  let quote = "";
  let found: number | null = null;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /[Ll]/.test(c) && !/\w/.test(query[i - 1] ?? " ")) {
      const m = /^LIMIT\s+(\d+)(?:\s*,\s*(\d+))?/i.exec(query.slice(i));
      // `LIMIT a, b` is offset a, count b.
      if (m) found = Number(m[2] ?? m[1]);
    }
  }
  return found ?? DEFAULT_LIMIT;
}

/**
 * Format HogQL row objects as CSV for the LLM. PostHog already returns columnar
 * data, so this is a flat table — no facet/timeseries/comparison branches needed.
 */
export function formatHogqlCsv(rows: Record<string, unknown>[], query?: string): string {
  if (rows.length === 0) return "No results.";

  const headers = Object.keys(rows[0]);
  const hdr = headers.map(csvEscape).join(",");

  const lines: string[] = [];
  let size = hdr.length;
  let rowCut = false;
  for (const r of rows) {
    let line = headers.map((k) => csvEscape(fmtVal(r[k]))).join(",");
    if (lines.length === 0 && size + line.length + 1 > MAX_RESULT_CHARS) {
      line = line.slice(0, Math.max(0, MAX_RESULT_CHARS - size - 1));
      rowCut = true;
    }
    // Always show one row, so a result is never empty.
    if (lines.length > 0 && size + line.length + 1 > MAX_RESULT_CHARS) break;
    lines.push(line);
    size += line.length + 1;
  }

  let note = rowCut ? `\n(Row cut at ${MAX_RESULT_CHARS} characters; select fewer columns.)` : "";
  if (lines.length < rows.length) {
    note = `\n(Showing ${lines.length} of ${rows.length} rows; the rest do not fit the ${MAX_RESULT_CHARS}-character result cap. Aggregate, narrow the window or lower the LIMIT to see the rest.)`;
  }
  // A result that fills the query's row limit, explicit or default, can be cut short.
  const limit = query === undefined ? null : outerLimit(query);
  if (rows.length === limit) note += `\n(The result fills the query's row limit of ${limit}; there can be more. This is not a total.)`;

  return `${hdr}\n${lines.join("\n")}${note}`;
}

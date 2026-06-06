// ── HogQL response → row objects + token-efficient CSV (for the LLM) ──

import type { HogQLQueryResponse } from "./types.js";

/** Zip the columnar Query API response into row objects keyed by column name. */
export function rowsToObjects(resp: HogQLQueryResponse): Record<string, unknown>[] {
  const { columns, results } = resp;
  if (!Array.isArray(results) || !Array.isArray(columns)) return [];
  return results.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
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
function isNumericValue(v: unknown): boolean {
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

// Cap how much of any one cell reaches the MODEL. PostHog `events` rows carry wide `properties`
// maps (GeoIP, UTM, device, $exception_list, ...) and long strings (URLs, messages); unbounded,
// a single row can be hundreds of tokens, and tool results are re-sent on every later step, so
// the cost compounds. The UI still gets the full untruncated rows via the query `parts`.
const MAX_CELL_CHARS = 200;

function fmtVal(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return v.length <= 5 ? v.join("; ") : `[${v.length} items]`;
  if (typeof v === "object") {
    const json = JSON.stringify(v);
    // A large map (typically a whole `properties` blob): show just the keys. That is what schema
    // discovery actually needs, without dumping every nested value into the model's context.
    return json.length <= MAX_CELL_CHARS ? json : `{ ${Object.keys(v).join(", ")} }`;
  }
  const s = String(v);
  return s.length <= MAX_CELL_CHARS ? s : `${s.slice(0, MAX_CELL_CHARS)}… [${s.length} chars]`;
}

/** Escape a value for CSV: quote if it contains commas, quotes, or newlines. */
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

/**
 * Format HogQL row objects as CSV for the LLM. PostHog already returns columnar
 * data, so this is a flat table — no facet/timeseries/comparison branches needed.
 */
export function formatHogqlCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results.";

  const headers = Object.keys(rows[0]);

  let displayRows = rows;
  let note = "";
  if (rows.length > 10) {
    displayRows = rows.slice(0, 10);
    note = `\n(${rows.length - 10} more rows omitted)`;
  }

  const hdr = headers.map(csvEscape).join(",");
  const body = displayRows
    .map((r) => headers.map((k) => csvEscape(fmtVal(r[k]))).join(","))
    .join("\n");

  return `${hdr}\n${body}${note}`;
}

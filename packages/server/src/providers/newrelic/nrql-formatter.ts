// ── Deterministic NRQL → CSV formatter (token-efficient for LLM) ──

const HIDDEN_KEYS = new Set(["beginTimeSeconds", "endTimeSeconds", "inspectedCount"]);

/** Rows of a table or event list that reach the model. */
const MAX_DISPLAY_ROWS = 50;
/** What NRQL returns when a query has no LIMIT clause. */
const DEFAULT_FACET_LIMIT = 10;
const DEFAULT_EVENT_LIMIT = 100;

function fmtVal(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    // toFixed(2) would turn 0.004 into "0.00"
    return Math.abs(v) < 1 ? Number(v.toPrecision(3)).toString() : v.toFixed(2);
  }
  if (Array.isArray(v)) return v.length <= 5 ? v.map((x) => (x != null && typeof x === "object" ? JSON.stringify(x) : x)).join("; ") : `[${v.length} items]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Escape a value for CSV: quote if it contains commas, quotes, or newlines. */
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function csvBlock(headers: string[], tableRows: string[][]): string {
  const hdr = headers.map(csvEscape).join(",");
  const body = tableRows.map((r) => r.map(csvEscape).join(",")).join("\n");
  return `${hdr}\n${body}`;
}

/** Find keys that duplicate facet values (same dedup logic as ResultView.buildColumns) */
function facetDupeKeys(sample: Record<string, unknown>): Set<string> {
  const dupes = new Set<string>();
  const facet = sample.facet;
  if (facet === undefined) return dupes;
  if (Array.isArray(facet)) {
    for (const val of facet) {
      for (const k of Object.keys(sample)) {
        if (k !== "facet" && !HIDDEN_KEYS.has(k) && sample[k] === val) dupes.add(k);
      }
    }
  } else {
    for (const k of Object.keys(sample)) {
      if (k !== "facet" && !HIDDEN_KEYS.has(k) && sample[k] === facet) dupes.add(k);
    }
  }
  return dupes;
}

function visibleKeys(sample: Record<string, unknown>): string[] {
  const dupes = facetDupeKeys(sample);
  return Object.keys(sample).filter((k) => k !== "facet" && k !== "comparison" && !HIDDEN_KEYS.has(k) && !dupes.has(k));
}

function facetLabel(sample: Record<string, unknown>): string {
  const dupes = facetDupeKeys(sample);
  return [...dupes][0] ?? "Name";
}

function facetValue(row: Record<string, unknown>): string {
  const f = row.facet;
  if (Array.isArray(f)) return f.map((v) => fmtVal(v)).join(" / ");
  return fmtVal(f);
}

// Object columns (apdex) hold their numbers as members.
function numbers(v: unknown, path: string): [string, number][] {
  if (typeof v === "number") return Number.isFinite(v) ? [[path, v]] : [];
  if (v == null || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => numbers(x, `${path}.${k}`));
}

/** Keep every 10th point, plus the max and min row of each number, in time order. */
function downsample(rows: Record<string, unknown>[], keys: string[]): { rows: Record<string, unknown>[]; step: number } {
  const step = Math.ceil(rows.length / 10);
  const keep = new Set<number>();
  for (let i = 0; i < rows.length; i += step) keep.add(i);
  const max = new Map<string, { i: number; v: number }>();
  const min = new Map<string, { i: number; v: number }>();
  rows.forEach((r, i) => {
    for (const [path, v] of keys.flatMap((k) => numbers(r[k], k))) {
      if (!max.has(path) || v > max.get(path)!.v) max.set(path, { i, v });
      if (!min.has(path) || v < min.get(path)!.v) min.set(path, { i, v });
    }
  });
  for (const { i } of [...max.values(), ...min.values()]) keep.add(i);
  return { rows: rows.filter((_, i) => keep.has(i)), step };
}

// A result that fills the query's row limit, explicit or default, can be cut short.
function limitNote(rows: number, query: string | undefined, defaultLimit: number): string {
  if (query === undefined) return "";
  const m = /\bLIMIT\s+(\d+|MAX)\b/i.exec(query);
  const limit = !m ? defaultLimit : /^max$/i.test(m[1]) ? null : Number(m[1]);
  return rows === limit ? `\n(The result fills the query's row limit of ${limit}; there can be more. This is not a total.)` : "";
}

export function formatNrqlCsv(rows: Record<string, unknown>[], query?: string): string {
  if (rows.length === 0) return "No results.";

  const sample = rows[0];

  // ── Timeseries ──
  if ("beginTimeSeconds" in sample) {
    const keys = visibleKeys(sample);
    let displayRows = rows;
    let note = "";
    if (rows.length > 10) {
      const sampled = downsample(rows, keys);
      displayRows = sampled.rows;
      note = `\n(Showing every ${sampled.step}th of ${rows.length} points, plus the peak and low points)`;
    }
    const faceted = "facet" in sample;
    const headers = ["Time", ...(faceted ? [facetLabel(sample)] : []), ...keys];
    const body = displayRows.map((r) => {
      // formatTimestamps already converts these to human-readable strings
      const time = r.endTimeSeconds != null ? String(r.endTimeSeconds)
        : r.beginTimeSeconds != null ? String(r.beginTimeSeconds)
        : "—";
      return [time, ...(faceted ? [facetValue(r)] : []), ...keys.map((k) => fmtVal(r[k]))];
    });
    return csvBlock(headers, body) + note;
  }

  // ── Histogram ──
  if (rows.length === 1 && Object.keys(sample).some((k) => k.startsWith("histogram."))) {
    const histKey = Object.keys(sample).find((k) => k.startsWith("histogram."))!;
    const buckets = sample[histKey];
    if (Array.isArray(buckets)) {
      const headers = ["Bucket", "Count"];
      const body = buckets.map((b: any) => [fmtVal(b.bucketStart ?? b.start), fmtVal(b.count)]);
      return csvBlock(headers, body);
    }
  }

  // ── Compare-with ──
  if ("comparison" in sample) {
    const keys = visibleKeys(sample);
    const periods: string[] = [];
    for (const r of rows) {
      const p = String(r.comparison);
      if (!periods.includes(p)) periods.push(p);
    }

    if ("facet" in sample) {
      // Compare + Facet → pivot table
      const grouped = new Map<string, Map<string, Record<string, unknown>>>();
      for (const r of rows) {
        const fk = facetValue(r);
        if (!grouped.has(fk)) grouped.set(fk, new Map());
        grouped.get(fk)!.set(String(r.comparison), r);
      }
      const fLabel = facetLabel(sample);
      const headers = [fLabel, ...keys.flatMap((k) => periods.map((p) => keys.length > 1 ? `${k} (${p})` : p))];
      const body = [...grouped.entries()].map(([fk, byPeriod]) => [
        fk,
        ...keys.flatMap((k) => periods.map((p) => fmtVal(byPeriod.get(p)?.[k]))),
      ]);
      return csvBlock(headers, body);
    }

    // Scalar comparison (no facet) → inline
    const parts: string[] = [];
    for (const k of keys) {
      for (const p of periods) {
        const row = rows.find((r) => String(r.comparison) === p);
        parts.push(`${k} (${p}): ${fmtVal(row?.[k])}`);
      }
    }
    return parts.join(", ");
  }

  // ── Uniques (single row, single key, array value) ──
  if (rows.length === 1) {
    const vKeys = visibleKeys(sample);
    if (vKeys.length === 1) {
      const val = sample[vKeys[0]];
      if (Array.isArray(val) && val.every((v) => typeof v !== "object" || v === null)) {
        return `${vKeys[0]}: ${val.join(", ")}`;
      }
    }
  }

  // ── Scalar (single row, all numeric, no facet) ──
  if (rows.length === 1 && !("facet" in sample)) {
    const keys = visibleKeys(sample);
    if (keys.length > 0 && keys.every((k) => typeof sample[k] === "number")) {
      return keys.map((k) => `${k}: ${fmtVal(sample[k])}`).join(", ");
    }
  }

  // ── Faceted table ──
  if ("facet" in sample) {
    const keys = visibleKeys(sample);
    const fLabel = facetLabel(sample);
    let displayRows = rows;
    let note = "";
    if (rows.length > MAX_DISPLAY_ROWS) {
      displayRows = rows.slice(0, MAX_DISPLAY_ROWS);
      note = `\n(${rows.length - MAX_DISPLAY_ROWS} more rows omitted)`;
    }
    note += limitNote(rows.length, query, DEFAULT_FACET_LIMIT);
    const headers = [fLabel, ...keys];
    const body = displayRows.map((r) => [facetValue(r), ...keys.map((k) => fmtVal(r[k]))]);
    return csvBlock(headers, body) + note;
  }

  // ── Raw events (fallback) ──
  const keys = visibleKeys(sample);
  let displayRows = rows;
  let note = "";
  if (rows.length > MAX_DISPLAY_ROWS) {
    displayRows = rows.slice(0, MAX_DISPLAY_ROWS);
    note = `\n(${rows.length - MAX_DISPLAY_ROWS} more rows omitted)`;
  }
  note += limitNote(rows.length, query, DEFAULT_EVENT_LIMIT);
  const headers = keys.length > 0 ? keys : Object.keys(sample);
  const body = displayRows.map((r) => headers.map((k) => fmtVal(r[k])));
  return csvBlock(headers, body) + note;
}

/** Strip NerdGraph internal metadata from rows before sending to UI. */
export function sanitizeNrqlRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "inspectedCount") continue;
      out[k] = v;
    }
    return out;
  });
}

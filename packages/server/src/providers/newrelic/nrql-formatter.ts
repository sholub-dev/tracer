// ── Deterministic NRQL → CSV formatter (token-efficient for LLM) ──

const HIDDEN_KEYS = new Set(["beginTimeSeconds", "endTimeSeconds", "inspectedCount"]);

function fmtVal(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }
  if (Array.isArray(v)) return v.length <= 5 ? v.join("; ") : `[${v.length} items]`;
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

export function formatNrqlCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "No results.";

  const sample = rows[0];

  // ── Timeseries ──
  if ("beginTimeSeconds" in sample) {
    const keys = visibleKeys(sample);
    let displayRows = rows;
    let note = "";
    if (rows.length > 10) {
      const step = Math.ceil(rows.length / 10);
      displayRows = rows.filter((_, i) => i % step === 0);
      note = `\n(Showing every ${step}th of ${rows.length} points)`;
    }
    const headers = ["Time", ...keys];
    const body = displayRows.map((r) => {
      // formatTimestamps already converts these to human-readable strings
      const time = r.endTimeSeconds != null ? String(r.endTimeSeconds)
        : r.beginTimeSeconds != null ? String(r.beginTimeSeconds)
        : "—";
      return [time, ...keys.map((k) => fmtVal(r[k]))];
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
    if (rows.length > 10) {
      displayRows = rows.slice(0, 10);
      note = `\n(${rows.length - 10} more rows omitted)`;
    }
    const headers = [fLabel, ...keys];
    const body = displayRows.map((r) => [facetValue(r), ...keys.map((k) => fmtVal(r[k]))]);
    return csvBlock(headers, body) + note;
  }

  // ── Raw events (fallback) ──
  const keys = visibleKeys(sample);
  let displayRows = rows;
  let note = "";
  if (rows.length > 10) {
    displayRows = rows.slice(0, 10);
    note = `\n(${rows.length - 10} more rows omitted)`;
  }
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

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

function fmtVal(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
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

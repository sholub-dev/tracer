import { isUnixMs, isUnixSec } from "@oko/shared";

export const HIDDEN_KEYS = new Set(["beginTimeSeconds", "endTimeSeconds", "inspectedCount"]);

export interface Column {
  key: string;
  label: string;
  get: (row: Record<string, unknown>) => unknown;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** NerdGraph returns percentile() results as single-key objects: {"99": 0.984375} */
export function isPercentileResult(value: unknown): boolean {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  return keys.length === 1 && !isNaN(Number(keys[0]));
}

export function formatValue(value: unknown, key?: string): string {
  if (value == null) return "—";
  if (typeof value === "number") {
    if (key && isUnixMs(key, value)) return formatTimestamp(value);
    if (key && isUnixSec(key, value)) return formatTimestamp(value * 1000);
    if (Number.isInteger(value) || Math.abs(value) > 1000) return value.toLocaleString();
    return value.toFixed(2);
  }
  if (Array.isArray(value)) {
    if (value.length <= 5) return value.join(", ");
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    if (isPercentileResult(value)) return formatValue(Object.values(value as object)[0] as unknown, key);
    return JSON.stringify(value);
  }
  return String(value);
}

export function buildColumns(rows: Record<string, unknown>[]): Column[] {
  const columns: Column[] = [];
  const sample = rows[0];
  const facet = sample.facet;
  const dupeKeys = new Set<string>();

  // Expand facet field into columns (NerdGraph puts FACET values here)
  // Also detect named keys that duplicate the facet values so we can skip them
  if (facet !== undefined) {
    if (Array.isArray(facet)) {
      facet.forEach((val, idx) => {
        // Find a named key whose value matches this facet position
        const namedKey = Object.keys(sample).find(
          (k) => k !== "facet" && !HIDDEN_KEYS.has(k) && sample[k] === val,
        );
        if (namedKey) dupeKeys.add(namedKey);
        columns.push({
          key: `facet-${idx}`,
          label: namedKey ?? `Group ${idx + 1}`,
          get: (row) => (row.facet as unknown[])[idx],
        });
      });
    } else {
      const namedKey = Object.keys(sample).find(
        (k) => k !== "facet" && !HIDDEN_KEYS.has(k) && sample[k] === facet,
      );
      if (namedKey) dupeKeys.add(namedKey);
      columns.push({
        key: "facet",
        label: namedKey ?? "Name",
        get: (row) => row.facet,
      });
    }
  }

  // Collect ALL unique keys across all rows, preserving first-appearance order
  const allKeys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        allKeys.push(key);
      }
    }
  }

  // Add remaining columns, skipping facet duplicates
  for (const key of allKeys) {
    if (key === "facet" || HIDDEN_KEYS.has(key) || dupeKeys.has(key)) continue;
    columns.push({ key, label: key, get: (row) => row[key] });
  }

  return columns;
}

/** Pivot COMPARE WITH rows: group by facet, show current/previous as side-by-side columns */
export function pivotCompareWith(rows: Record<string, unknown>[]) {
  const metricKeys = Object.keys(rows[0]).filter(
    (k) => k !== "facet" && k !== "comparison" && !HIDDEN_KEYS.has(k),
  );
  // Find the facet label key (duplicate of facet value)
  const sample = rows[0];
  const facetVal = sample.facet;
  const dupeKeys = new Set<string>();
  for (const k of metricKeys) {
    if (
      Array.isArray(facetVal)
        ? facetVal.includes(sample[k])
        : sample[k] === facetVal
    ) {
      dupeKeys.add(k);
    }
  }
  const facetLabel =
    [...dupeKeys][0] ?? (typeof facetVal === "string" ? "Name" : "Group");
  const valueKeys = metricKeys.filter((k) => !dupeKeys.has(k));

  // Collect unique comparison periods in order of appearance
  const periods: string[] = [];
  for (const r of rows) {
    const p = String(r.comparison);
    if (!periods.includes(p)) periods.push(p);
  }

  // Group rows by facet key (stringified for arrays)
  const grouped = new Map<
    string,
    { label: unknown; byPeriod: Map<string, Record<string, unknown>> }
  >();
  for (const row of rows) {
    const fKey = Array.isArray(row.facet)
      ? JSON.stringify(row.facet)
      : String(row.facet);
    if (!grouped.has(fKey)) {
      grouped.set(fKey, { label: row.facet, byPeriod: new Map() });
    }
    grouped.get(fKey)!.byPeriod.set(String(row.comparison), row);
  }

  return { facetLabel, valueKeys, periods, grouped };
}

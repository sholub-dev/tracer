import { stripStrings } from "./nrql-formatter.js";

const OUTER = new Set(["max", "min", "sum", "average", "avg", "median", "stddev", "latest", "earliest", "count", "uniquecount"]);
const INNER = new Set([...OUTER, "percentage", "apdex", "percentile", "rate"]);
const UNIT_MINUTES: Record<string, number> = { second: 1 / 60, minute: 1, hour: 60, day: 1440, week: 10080 };
const BUCKETS = [1, 5, 10, 15, 30, 60, 180, 360, 720, 1440];

function hasNestedAggregate(query: string): boolean {
  const stack: string[] = [];
  for (const m of (stripStrings(query) ?? "").matchAll(/([A-Za-z_]\w*)?\s*([()])/g)) {
    if (m[2] === ")") { stack.pop(); continue; }
    const name = (m[1] ?? "").toLowerCase();
    if (INNER.has(name) && stack.some((o) => OUTER.has(o))) return true;
    stack.push(name);
  }
  return false;
}

function windowMinutes(query: string): number | null {
  const abs = /\bSINCE\s+'([^']+)'\s+UNTIL\s+'([^']+)'/i.exec(query);
  if (abs) {
    const ms = Date.parse(abs[2]) - Date.parse(abs[1]);
    return ms > 0 ? ms / 60000 : null;
  }
  const rel = /\bSINCE\s+(\d+)\s+(second|minute|hour|day|week)s?\s+ago\b(?!\s+UNTIL)/i.exec(query);
  return rel ? Number(rel[1]) * UNIT_MINUTES[rel[2].toLowerCase()] : null;
}

function bucketLabel(minutes: number): string {
  if (minutes >= 1440) return "1 day";
  if (minutes >= 60) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function bucketHint(query: string): string {
  const window = windowMinutes(query);
  if (!window) return "window / bucket must be 366 or less.";
  const need = window / 366;
  const bucket = BUCKETS.find((b) => b >= need) ?? 1440;
  return `Use a bucket of at least ${bucketLabel(bucket)} for this window.`;
}

export function nrqlFixHint(message: string, query: string): string | null {
  if (/unexpected '(ASC|DESC)'/i.test(message)) {
    return "After FACET, write ORDER BY <aggregate> without ASC or DESC; it sorts highest first. For the lowest values use LIMIT MAX and read the whole result.";
  }
  if (/Unknown function \w+\(\)/i.test(message) && hasNestedAggregate(query)) {
    return "Aggregates cannot be nested. Query the inner function with TIMESERIES and read its peak, or use a subquery.";
  }
  if (/TIMESERIES supports a maximum of 366 buckets/i.test(message)) return bucketHint(query);
  if (/unexpected '[^']*count\(/i.test(message) && /count\s*\(\s*distinct\b/i.test(query)) {
    return "Use uniqueCount(x) instead of count(DISTINCT x).";
  }
  const bare = /Value must be constant in its context: Id\{name='([^']+)'/i.exec(message);
  if (bare) {
    return `A query with aggregates cannot also select the plain attribute ${bare[1]}. Move ${bare[1]} to FACET and select only aggregates.`;
  }
  if (/FACET cannot be used when selecting on event fields/i.test(message)) {
    return "Select an aggregate such as count(*) with FACET, not raw event fields.";
  }
  return null;
}

export function withFixHint(message: string, query: string): string {
  const hint = nrqlFixHint(message, query);
  return hint ? `${message}\nFix: ${hint}` : message;
}

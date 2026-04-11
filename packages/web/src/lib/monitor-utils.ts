import { substituteTimeRange } from "@oko/shared";
import type { Threshold } from "../components/charts/ChartView";

export const MONITOR_PRESETS = [
  { label: "1 hour", since: "1 hour ago" },
  { label: "3 hours", since: "3 hours ago" },
  { label: "8 hours", since: "8 hours ago" },
  { label: "24 hours", since: "24 hours ago" },
] as const;

/** Convert "X hours/minutes ago" to seconds */
export function sinceToSeconds(since: string): number {
  const m = since.match(/([\d.]+)\s*(minute|hour|day)/i);
  if (!m) return 3600;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("minute")) return n * 60;
  if (unit.startsWith("hour")) return n * 3600;
  return n * 86400;
}

export const MAX_BUCKETS = 366;

/**
 * Build TIMESERIES clause with bucket size = multiple of the monitor's
 * evaluation window, scaled up if needed to stay within NerdGraph's 366-bucket limit.
 */
export function timeseriesClause(frequencySeconds: number, since: string): string {
  const evalWindow = frequencySeconds * 2;
  const rangeSeconds = sinceToSeconds(since);
  const multiplier = Math.max(1, Math.ceil(rangeSeconds / (evalWindow * MAX_BUCKETS)));
  return `TIMESERIES ${evalWindow * multiplier} seconds`;
}

/** Extract the data threshold from a monitor condition expression.
 *  Matches `.field > number` patterns, skipping structural checks like `.length > 0`. */
export function parseThreshold(condition: string): Threshold | undefined {
  const matches = [...condition.matchAll(/\.(\w+)\s*(>=|<=|>|<)\s*([\d.]+)/g)];
  for (const m of matches) {
    if (m[1] === "length") continue;
    return { operator: m[2] as Threshold["operator"], value: parseFloat(m[3]) };
  }
  return undefined;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleString();
}

export function resolveQueryDisplay(query: string, frequencySeconds: number): string {
  const lookback = frequencySeconds * 2;
  return substituteTimeRange(query, `${lookback} seconds ago`);
}

export function statusVariant(status: string): "error" | "warn" | "success" {
  return status === "alert" ? "error" : status === "error" ? "warn" : "success";
}

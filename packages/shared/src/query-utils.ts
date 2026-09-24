export function substituteTimeRange(query: string, since: string, until = "NOW"): string {
  return query.replace(/\{\{SINCE\}\}/g, since).replace(/\{\{UNTIL\}\}/g, until);
}

/** Fill {{SINCE}}/{{UNTIL}} with a window in the provider's format: PostHog epoch seconds, New Relic epoch ms. */
export function substituteWindow(provider: string, query: string, startSec: number, endSec: number): string {
  const fmt = (s: number) => String(provider === "posthog" ? s : s * 1000);
  return substituteTimeRange(query, fmt(startSec), fmt(endSec));
}

// ── Timestamp utilities ──

const TIMESTAMP_KEYS = new Set([
  "timestamp",
  "start",
  "end",
  "created_at",
  "updated_at",
  "time",
]);

/** Check if a numeric value looks like a Unix millisecond timestamp. */
export function isUnixMs(key: string, value: number): boolean {
  if (TIMESTAMP_KEYS.has(key)) return value > 1_000_000_000_000;
  return /time/i.test(key) && value > 1_000_000_000_000 && value < 3_000_000_000_000;
}

/** Check if a numeric value looks like a Unix second timestamp. */
export function isUnixSec(key: string, value: number): boolean {
  if (TIMESTAMP_KEYS.has(key)) return value > 1_000_000_000 && value < 1_000_000_000_000;
  return /time/i.test(key) && value > 1_000_000_000 && value < 3_000_000_000;
}

const tsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Format a millisecond timestamp in the given timezone, with its zone label (e.g. "2026-09-24 14:00:00 PDT"). */
function formatTs(ms: number, timeZone = "UTC"): string {
  let fmt = tsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
    });
    tsFormatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
}

/** Returns the current Unix timestamp in seconds. */
export const unixNow = () => Math.floor(Date.now() / 1000);

/** Convert unix timestamps in query results to human-readable strings so the model doesn't hallucinate dates. */
export function formatTimestamps(results: unknown, timeZone?: string): unknown {
  if (!Array.isArray(results)) return results;
  return results.map((row) => {
    if (typeof row !== "object" || row === null) return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const [key, val] of Object.entries(out)) {
      if (typeof val === "number") {
        if (isUnixMs(key, val)) {
          out[key] = formatTs(val, timeZone);
        } else if (isUnixSec(key, val)) {
          out[key] = formatTs(val * 1000, timeZone);
        }
      }
    }
    return out;
  });
}

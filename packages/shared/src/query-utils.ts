export function substituteTimeRange(query: string, since: string, until = "NOW"): string {
  return query.replace(/\{\{SINCE\}\}/g, since).replace(/\{\{UNTIL\}\}/g, until);
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

/** Format a millisecond timestamp as a human-readable date string. */
function formatTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Returns the current Unix timestamp in seconds. */
export const unixNow = () => Math.floor(Date.now() / 1000);

/** Convert unix timestamps in query results to human-readable strings so the model doesn't hallucinate dates. */
export function formatTimestamps(results: unknown): unknown {
  if (!Array.isArray(results)) return results;
  return results.map((row) => {
    if (typeof row !== "object" || row === null) return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const [key, val] of Object.entries(out)) {
      if (typeof val === "number") {
        if (isUnixMs(key, val)) {
          out[key] = formatTs(val);
        } else if (isUnixSec(key, val)) {
          out[key] = formatTs(val * 1000);
        }
      }
    }
    return out;
  });
}

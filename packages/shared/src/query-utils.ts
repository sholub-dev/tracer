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

export const isPlainObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);

/** The member of an object column that stands for it. Integer-like keys always enumerate in ascending order and
 * alerts care about the tail, so when every key is numeric (percentiles) it is the highest; otherwise the first. */
export function mainMemberKey(obj: Record<string, unknown>): string | undefined {
  const keys = Object.keys(obj);
  if (keys.length > 0 && keys.every((k) => k.trim() !== "" && Number.isFinite(Number(k)))) {
    return keys.reduce((hi, k) => (Number(k) > Number(hi) ? k : hi));
  }
  return keys[0];
}

type Row = Record<string, unknown>;

/**
 * Some providers return an object-valued field and also copy all of its members into the row as extra keys.
 * Decide once per result: find the copy keys from rows where every member of the object appears as a key with an
 * equal value, and drop them from every row unless some row holds a different value under such a key.
 * A real column that merely shares one name and value stays.
 */
export function dropFlattenedResultCopies<T extends Row>(rows: T[]): T[] {
  const copies = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const [objKey, o] of Object.entries(row)) {
      if (!isPlainObject(o)) continue;
      const members = Object.entries(o);
      if (members.length > 0 && members.every(([k, v]) => v != null && typeof v !== "object" && row[k] === v)) {
        const set = copies.get(objKey) ?? new Set<string>();
        for (const [k] of members) set.add(k);
        copies.set(objKey, set);
      }
    }
  }
  if (copies.size === 0) return rows;
  for (const row of rows) {
    for (const [objKey, keys] of copies) {
      const o = row[objKey];
      if (isPlainObject(o) && [...keys].some((k) => k in row && k in o && row[k] !== o[k])) return rows;
    }
  }
  const drop = new Set([...copies.values()].flatMap((s) => [...s]));
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k))) as T);
}

export function dropFlattenedCopies<T extends Row>(row: T): T {
  const [out] = dropFlattenedResultCopies([row]);
  return out;
}

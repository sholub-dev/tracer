/**
 * Thin HogQL query templates for the dashboard/data routes. The chat agent
 * writes its own HogQL via the execute_hogql tool; these cover the normalized
 * getErrors/getTransactions/getLogs provider methods only.
 */

/** Escape a single-quoted HogQL string literal. Backslashes first, then quotes. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Translate Tracer's NRQL-style `since`/`until` strings (e.g. "24 hours ago",
 * "1 hour ago", "today") into a HogQL datetime expression. Falls back to 24h.
 */
function timeExpr(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === "today") return "toStartOfDay(now())";
  if (v === "yesterday") return "toStartOfDay(now()) - interval 1 day";

  const rel = v.match(/^(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago$/);
  if (rel) return `now() - interval ${rel[1]} ${rel[2]}`;

  // Explicit timestamp literal (e.g. "2024-01-15 14:00:00"). Anything else is
  // unrecognized — fall back to the 24h default rather than emit a broken literal.
  if (/\d{4}-\d{2}-\d{2}/.test(value)) return `toDateTime('${esc(value.trim())}')`;
  return "now() - interval 24 hour";
}

function timeFilter(since: string, until?: string): string {
  const sinceExpr = since ? timeExpr(since) : "now() - interval 24 hour";
  const untilClause = until ? ` AND timestamp <= ${timeExpr(until)}` : "";
  return ` AND timestamp >= ${sinceExpr}${untilClause}`;
}

/**
 * Group $exception events into error classes. Type and message live inside the
 * 1-indexed $exception_list array; older SDKs emitted flat $exception_type/
 * $exception_message, so coalesce covers both. $exception_fingerprint is optional.
 */
export function errorQuery(since: string, until?: string): string {
  return `SELECT
  coalesce(properties.$exception_list[1].type, properties.$exception_type) AS error_class,
  coalesce(properties.$exception_list[1].value, properties.$exception_message) AS message,
  properties.$exception_fingerprint AS fingerprint,
  count() AS count,
  min(timestamp) AS first_seen,
  max(timestamp) AS last_seen
FROM events
WHERE event = '$exception'${timeFilter(since, until)}
GROUP BY error_class, message, fingerprint
ORDER BY count DESC
LIMIT 100`;
}

/**
 * Best-effort "transactions" from $pageview volume. PostHog is not an APM —
 * there is no request duration or error rate; only throughput (event count).
 */
export function transactionQuery(since: string, until?: string): string {
  return `SELECT
  coalesce(properties.$pathname, properties.$current_url) AS name,
  count() AS throughput
FROM events
WHERE event = '$pageview'${timeFilter(since, until)}
GROUP BY name
ORDER BY throughput DESC
LIMIT 100`;
}

/** Recent event stream, optionally filtered by event name or URL. */
export function logQuery(since: string, filter?: string, until?: string): string {
  const filterClause = filter
    ? ` AND (event ILIKE '%${esc(filter)}%' OR properties.$current_url ILIKE '%${esc(filter)}%')`
    : "";
  return `SELECT timestamp, event, properties.$current_url AS url, distinct_id
FROM events
WHERE 1 = 1${timeFilter(since, until)}${filterClause}
ORDER BY timestamp DESC
LIMIT 200`;
}

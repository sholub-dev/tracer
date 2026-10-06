// Error types that providers send inside a stream instead of an HTTP status, and that repeat on every run.
const PERMANENT_TYPES = /invalid_request|authentication|permission|not_found|request_too_large/i;

/**
 * True when the same request can succeed if it runs again. False only for errors known to repeat:
 * a user stop, a 4xx answer (bad key, bad request) other than 408/409/429, or a stream error of such a type.
 * Any other error counts as transient: network and provider failures take too many shapes to list
 * (WebKit and Node network errors, a cut stream, a malformed tool call), and a needless re-run costs little.
 */
export function isTransientError(err: unknown): boolean {
  for (let current = err, depth = 0; current != null && typeof current === "object" && depth < 5; depth++) {
    const e = current as { name?: unknown; reason?: unknown; isRetryable?: unknown; statusCode?: unknown; status?: unknown; type?: unknown; cause?: unknown; lastError?: unknown };
    if (e.name === "AbortError") return false;
    // The AI SDK gives up on retryable errors with a RetryError that has no status or cause.
    if (e.reason === "maxRetriesExceeded") return true;
    if (e.isRetryable === true) return true;
    // A cut stream after a 200 answer also carries its status, so only an error status decides.
    const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
    if (typeof status === "number" && status >= 400) return status === 408 || status === 409 || status === 429 || status >= 500;
    if (typeof e.type === "string" && PERMANENT_TYPES.test(e.type)) return false;
    current = e.cause ?? e.lastError;
  }
  return true;
}

// Node reports a dropped connection through a cause code; WebKit only through the message.
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const NETWORK_MESSAGE = /fetch failed|failed to fetch|load failed|network connection was lost|internet connection appears to be offline|networkerror|network error|terminated|socket hang up|timed out|no data from the model|overloaded/i;
// Error types that providers send inside a stream instead of an HTTP status.
const TRANSIENT_TYPES = /overloaded|rate_limit|api_error|timeout/i;

/**
 * True when the same request can succeed if it runs again: a dropped or refused connection,
 * a timeout, a rate limit or a server error. False for a user stop and for errors that repeat (bad key, bad request).
 */
export function isTransientError(err: unknown): boolean {
  for (let current = err, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== "object") return NETWORK_MESSAGE.test(String(current));
    const e = current as { name?: unknown; reason?: unknown; isRetryable?: unknown; statusCode?: unknown; status?: unknown; code?: unknown; type?: unknown; message?: unknown; cause?: unknown };
    if (e.name === "AbortError") return false;
    if (e.name === "TimeoutError") return true;
    // The AI SDK gives up on retryable errors with a RetryError that has no status or cause.
    if (e.reason === "maxRetriesExceeded") return true;
    if (typeof e.isRetryable === "boolean") return e.isRetryable;
    const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
    if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
    if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
    if (typeof e.type === "string" && TRANSIENT_TYPES.test(e.type)) return true;
    if (typeof e.message === "string" && NETWORK_MESSAGE.test(e.message)) return true;
    current = e.cause;
  }
  return false;
}

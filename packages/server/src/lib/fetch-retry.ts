import { CONFIG } from "../config.js";

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_AFTER_MAX_MS = 10_000;

export interface RetryOptions {
  /** Limit for each attempt. A fresh timeout starts per attempt, so a spent one cannot fail the next. */
  timeoutMs?: number;
  /** Set to false for a request that must not run twice. */
  retry?: boolean;
}

function retryDelay(res: Response | undefined, base: number): number {
  const seconds = Number(res?.headers.get("retry-after"));
  if (res && (res.status === 429 || res.status === 503) && Number.isFinite(seconds) && seconds > 0) {
    return Math.max(base, Math.min(seconds * 1000, RETRY_AFTER_MAX_MS));
  }
  return base;
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A signal that follows `caller` and aborts after `ms`, plus a promise that rejects on either abort.
 * Racing it covers a caller that ignores the signal: the iOS native HTTP layer waits up to 600 s.
 * Not AbortSignal.any: it needs iOS 17.4, and the app supports iOS 15. `clear` removes the timer and the caller link.
 */
export function abortAfter(caller: AbortSignal | null | undefined, ms: number | undefined, message: string, onTimeout?: () => void) {
  const controller = new AbortController();
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  // After a response, the abort only stops the body read; nothing awaits this rejection then.
  stopped.catch(() => {});
  const onCallerAbort = () => controller.abort(caller!.reason);
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = ms === undefined ? undefined : setTimeout(() => {
    onTimeout?.();
    controller.abort(new DOMException(message, "TimeoutError"));
  }, ms);
  return {
    signal: controller.signal,
    stopped,
    clear: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** A response keeps its timer and caller link: they also limit reading the body, until `clear`. */
async function fetchOnce(input: string | URL, init: RequestInit, options: RetryOptions): Promise<{ res: Response; clear: () => void }> {
  const delays = options.retry === false ? [] : CONFIG.fetchRetryDelaysMs;
  const caller = init.signal;
  for (let attempt = 0; ; attempt++) {
    const link = abortAfter(caller, options.timeoutMs, "The request timed out");
    let res: Response | undefined;
    try {
      res = await Promise.race([fetch(input, { ...init, signal: link.signal }), link.stopped]);
    } catch (err) {
      link.clear();
      if (caller?.aborted || attempt >= delays.length) throw err;
    }
    if (res && (!RETRY_STATUSES.has(res.status) || attempt >= delays.length)) return { res, clear: link.clear };
    if (res) {
      link.clear();
      await res.body?.cancel().catch(() => {});
    }
    await wait(retryDelay(res, delays[attempt]), caller);
  }
}

/**
 * fetch that repeats the request after a network error or a 408/429/5xx response.
 * Returns the last response, or throws the last error. A caller abort stops at once.
 * Any rejection that is not a caller abort counts as transient: the native HTTP layer on iOS uses its own error shapes.
 */
export async function fetchWithRetry(input: string | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  return (await fetchOnce(input, init, options)).res;
}

export interface FetchedText {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

/** fetchWithRetry that reads the body, then ends the timer and the caller link. A failed read throws only for an ok response. */
export async function fetchText(input: string | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<FetchedText> {
  const { res, clear } = await fetchOnce(input, init, options);
  try {
    const text = await res.text().catch((err: unknown) => {
      if (res.ok) throw err;
      return "";
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText, text };
  } finally {
    clear();
  }
}

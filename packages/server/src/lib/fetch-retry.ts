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
 * fetch that repeats the request after a network error or a 408/429/5xx response.
 * Returns the last response, or throws the last error. A caller abort stops at once.
 * Any rejection that is not a caller abort counts as transient: the native HTTP layer on iOS uses its own error shapes.
 */
export async function fetchWithRetry(input: string | URL, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const delays = options.retry === false ? [] : CONFIG.fetchRetryDelaysMs;
  const caller = init.signal;
  for (let attempt = 0; ; attempt++) {
    // Not AbortSignal.any: it needs iOS 17.4, and the app supports iOS 15.
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(caller!.reason);
    if (caller?.aborted) onCallerAbort();
    else caller?.addEventListener("abort", onCallerAbort, { once: true });
    // The iOS native HTTP layer ignores the signal and waits up to 600 s, so the timer also rejects on its own.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = options.timeoutMs === undefined ? undefined : new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new DOMException("The request timed out", "TimeoutError");
        controller.abort(err);
        reject(err);
      }, options.timeoutMs);
    });
    // After a response, the timer only stops the body read; nothing awaits this rejection then.
    timedOut?.catch(() => {});
    let res: Response | undefined;
    try {
      const request = fetch(input, { ...init, signal: controller.signal });
      res = await (timedOut ? Promise.race([request, timedOut]) : request);
    } catch (err) {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
      if (caller?.aborted || attempt >= delays.length) throw err;
    }
    // A response keeps its timer and the caller link: they also limit reading the body.
    if (res && (!RETRY_STATUSES.has(res.status) || attempt >= delays.length)) return res;
    if (res) {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onCallerAbort);
      await res.body?.cancel().catch(() => {});
    }
    await wait(retryDelay(res, delays[attempt]), caller);
  }
}

/** A signal that aborts after `ms`. Not AbortSignal.timeout: it needs iOS 16, and the app supports iOS 15. */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), ms);
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

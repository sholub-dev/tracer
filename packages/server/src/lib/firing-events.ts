// A plain listener set, like session-events.
const listeners = new Set<() => void>();

/** Tells every open subscription that the set of firings waiting for a Yes or No changed. */
export function pendingFiringsChanged(): void {
  for (const listener of listeners) listener();
}

/** Yields once on subscribing, then after each change, until `signal` aborts. */
export async function* pendingFiringChanges(signal?: AbortSignal): AsyncGenerator<void> {
  let changed = true;
  let wake: (() => void) | undefined;
  const listener = () => { changed = true; wake?.(); };
  const onAbort = () => wake?.();
  listeners.add(listener);
  signal?.addEventListener("abort", onAbort);
  try {
    while (!signal?.aborted) {
      if (changed) {
        changed = false;
        yield;
        continue;
      }
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  } finally {
    listeners.delete(listener);
    signal?.removeEventListener("abort", onAbort);
  }
}

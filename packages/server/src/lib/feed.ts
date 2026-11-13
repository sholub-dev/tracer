/**
 * A plain listener set instead of EventTarget: Node's EventTarget warns past 10 listeners, one per open subscription.
 * A value already waiting in a subscriber's queue means "refetch", so a repeat adds nothing, and a subscriber that
 * stops reading holds at most one entry per distinct value. `initial` values are yielded first on each subscription.
 */
export function createFeed<T>(initial: readonly T[] = []) {
  const listeners = new Set<(value: T) => void>();

  return {
    emit(value: T): void {
      for (const listener of listeners) listener(value);
    },

    /** Yields each emitted value until `signal` aborts. */
    async *subscribe(signal?: AbortSignal): AsyncGenerator<T> {
      const queue = new Set<T>(initial);
      let wake: (() => void) | undefined;
      const listener = (value: T) => {
        queue.add(value);
        wake?.();
      };
      const onAbort = () => wake?.();
      listeners.add(listener);
      signal?.addEventListener("abort", onAbort);
      try {
        while (!signal?.aborted) {
          if (queue.size > 0) {
            const value = queue.values().next().value as T;
            queue.delete(value);
            yield value;
            continue;
          }
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
      } finally {
        listeners.delete(listener);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

// A plain listener set instead of EventTarget: Node's EventTarget warns past 10 listeners, one per open subscription.
const listeners = new Set<(id: string) => void>();

/** Notifies with a session id whenever its chat_sessions row is created, changed (status/title/order) or deleted. */
export function sessionChanged(...ids: string[]): void {
  for (const id of ids) for (const listener of listeners) listener(id);
}

/** Yields each changed session id until `signal` aborts. */
export async function* sessionChanges(signal?: AbortSignal): AsyncGenerator<string> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  const listener = (id: string) => { queue.push(id); wake?.(); };
  const onAbort = () => wake?.();
  listeners.add(listener);
  signal?.addEventListener("abort", onAbort);
  try {
    while (!signal?.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
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

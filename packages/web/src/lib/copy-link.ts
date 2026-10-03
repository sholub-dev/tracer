import { useSyncExternalStore } from "react";

let link: string | null = null;
const listeners = new Set<() => void>();

export function setCopyLink(next: string | null) {
  link = next;
  listeners.forEach((l) => l());
}

export function useCopyLink(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => link,
  );
}

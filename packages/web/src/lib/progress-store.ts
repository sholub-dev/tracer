import { useCallback, useSyncExternalStore } from "react";

import type { ProgressPart } from "@oko/shared";

export interface NrqlProgress {
  parts: ProgressPart[];
}

type Listener = () => void;

export class ProgressStore {
  private data = new Map<string, NrqlProgress>();
  private listeners = new Map<string, Set<Listener>>();
  private pendingIds = new Set<string>();
  private rafId: number | null = null;

  update(toolCallId: string, updater: (prev: NrqlProgress | undefined) => NrqlProgress) {
    const prev = this.data.get(toolCallId);
    this.data.set(toolCallId, updater(prev));
    this.pendingIds.add(toolCallId);
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        const ids = new Set(this.pendingIds);
        this.pendingIds.clear();
        for (const id of ids) {
          this.listeners.get(id)?.forEach((fn) => fn());
        }
      });
    }
  }

  getSnapshot(toolCallId: string): NrqlProgress | undefined {
    return this.data.get(toolCallId);
  }

  clear() {
    this.data.clear();
    this.listeners.clear();
    this.pendingIds.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  subscribe(toolCallId: string, callback: Listener): () => void {
    let set = this.listeners.get(toolCallId);
    if (!set) {
      set = new Set();
      this.listeners.set(toolCallId, set);
    }
    set.add(callback);
    return () => { set!.delete(callback); };
  }
}

export function useProgress(store: ProgressStore, toolCallId: string | undefined): NrqlProgress | undefined {
  const subscribe = useCallback(
    (cb: Listener) => (toolCallId ? store.subscribe(toolCallId, cb) : () => {}),
    [store, toolCallId],
  );
  const getSnapshot = useCallback(
    () => (toolCallId ? store.getSnapshot(toolCallId) : undefined),
    [store, toolCallId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

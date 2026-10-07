import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "./trpc";
import { AVAILABLE_MODELS } from "./models";
import { WEB_CONFIG } from "./config";
import { IS_IOS } from "./platform";

/** Chat scroll that follows content growth; any upward scroll pauses it until the bottom is reached again. A new `mountKey` re-attaches to a swapped container. */
export function useChatScroll(mountKey?: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  // Set when the view stops at an answer card; only the user's own input clears it.
  const pinned = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((opts?: { animation?: "instant" | "smooth" }) => {
    const el = scrollRef.current;
    if (!el) return;
    shouldAutoScroll.current = true;
    pinned.current = false;
    el.scrollTo({ top: el.scrollHeight, behavior: opts?.animation === "smooth" ? "smooth" : "instant" });
  }, []);

  const scrollToTop = useCallback((opts?: { animation?: "instant" | "smooth" }) => {
    const el = scrollRef.current;
    if (!el) return;
    shouldAutoScroll.current = false;
    el.scrollTo({ top: 0, behavior: opts?.animation === "smooth" ? "smooth" : "instant" });
  }, []);

  // Track isAtBottom and re-enable auto-scroll when user scrolls back down
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastTop = el.scrollTop;
    let lastHeight = el.scrollHeight;
    // Any upward move pauses (even near the bottom); a drop from content shrinking is not the user.
    const onScroll = () => {
      const top = el.scrollTop;
      const height = el.scrollHeight;
      const atBottom = height - top - el.clientHeight < 50;
      setIsAtBottom(atBottom);
      if (top < lastTop && height >= lastHeight) shouldAutoScroll.current = false;
      else if (atBottom && !pinned.current) shouldAutoScroll.current = true;
      lastTop = top;
      lastHeight = height;
    };
    const onUser = () => { pinned.current = false; };
    // pointerdown, not touchmove: charts stop touchmove propagation, and a scrollbar drag sends no wheel event.
    const inputs = ["wheel", "pointerdown", "keydown"];
    el.addEventListener("scroll", onScroll, { passive: true });
    for (const type of inputs) el.addEventListener(type, onUser, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      for (const type of inputs) el.removeEventListener(type, onUser);
    };
  }, [mountKey]);

  // ResizeObserver on inner content div — auto-scrolls on any content growth
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // A new answer card stops the follow at the card, so the answer stays in view while its charts load below.
    // Opening a session stops at the last reply's card; older cards, and cards that appear (or remount) while the
    // follow is paused, never stop it later.
    const cardsNow = () => [...el.querySelectorAll("[data-answer-card]")];
    const lastRow = [...el.querySelectorAll("[data-role]")].at(-1);
    const openCard = lastRow?.getAttribute("data-role") === "assistant" ? [...lastRow.querySelectorAll("[data-answer-card]")].at(-1) : undefined;
    const seen = new WeakSet<Element>(cardsNow().filter((c) => c !== openCard));
    const ro = new ResizeObserver(() => {
      const fresh = cardsNow().filter((c) => !seen.has(c));
      fresh.forEach((c) => seen.add(c));
      if (!shouldAutoScroll.current) return;
      const scroller = scrollRef.current;
      const card = fresh.at(-1);
      if (!card || !scroller) return scrollToBottom();
      const header = scroller.querySelector("[data-page-header]")?.getBoundingClientRect().height ?? 0;
      shouldAutoScroll.current = false;
      pinned.current = true;
      scroller.scrollTo({ top: scroller.scrollTop + card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - header - 16 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom, mountKey]);

  return { scrollRef, contentRef, isAtBottom, scrollToBottom, scrollToTop };
}

/** Measure container size via ResizeObserver */
export function useContainerSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      // 0 width = hidden (display:none); keep the last size so nothing re-renders.
      if (!rect || rect.width <= 0) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((p) => (p.width === width && p.height === height ? p : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, size };
}

/** Poll a tRPC query by invalidating at a fixed interval. */
export function usePolling(
  invalidate: () => void,
  intervalMs: number,
  enabled: boolean,
  immediate = true,
) {
  const callbackRef = useRef(invalidate);
  callbackRef.current = invalidate;

  useEffect(() => {
    if (!enabled) return;
    if (immediate) callbackRef.current();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") callbackRef.current();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") callbackRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, immediate]);
}

/** Keeps session-derived queries fresh from the server's session change stream; bursts are coalesced. */
export function useSessionLiveUpdates() {
  const utils = trpc.useUtils();
  const pending = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateLists = useCallback(() => {
    utils.sessions.list.invalidate();
    utils.monitors.builderChats.invalidate();
    utils.monitors.triggers.invalidate();
    utils.monitors.list.invalidate();
  }, [utils]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);

  trpc.sessions.onChange.useSubscription(undefined, {
    // Also fires on every reconnect, covering changes missed while disconnected.
    onStarted: () => {
      invalidateLists();
      utils.sessions.getTitle.invalidate();
      utils.sessions.timer.invalidate();
    },
    onData: ({ id }) => {
      pending.current.add(id);
      timer.current ??= setTimeout(() => {
        timer.current = null;
        invalidateLists();
        for (const sessionId of pending.current) {
          utils.sessions.getTitle.invalidate({ id: sessionId });
          utils.sessions.timer.invalidate({ id: sessionId });
        }
        pending.current.clear();
      }, WEB_CONFIG.sessionEventCoalesceMs);
    },
  });
}

/** Deletes a session and refreshes every list that can show it; `noun` names it in the toasts. */
export function useDeleteSession({ noun = "investigation", onDeleted }: { noun?: string; onDeleted?: (id: string) => void } = {}) {
  const utils = trpc.useUtils();
  const mutation = trpc.sessions.delete.useMutation({
    onSuccess: (_, { id }) => {
      utils.sessions.list.invalidate();
      utils.monitors.triggers.invalidate();
      utils.monitors.list.invalidate();
      utils.monitors.builderChats.invalidate();
      toast(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} deleted`);
      onDeleted?.(id);
    },
    onError: () => toast.error(`Couldn't delete the ${noun}`),
  });
  return (id: string) => mutation.mutate({ id });
}

/** Escape calls `onStop` while `active`, unless an open dialog or menu took the key. */
export function useEscapeToStop(active: boolean, onStop: () => void) {
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog],[role=alertdialog],[role=menu]")) return;
      onStopRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}

/** Polled gcloud auth status, shared by the GCP project picker and the Vertex card. */
export function useGcpAuthStatus() {
  return trpc.provider.gcpAuthStatus.useQuery(undefined, {
    refetchInterval: WEB_CONFIG.sessionStaleTimeMs,
    // The iOS app has no gcloud credentials to read.
    enabled: !IS_IOS,
  });
}

/** GCP projects as select options; `enabled` defers the fetch until a picker opens. */
export function useGcpProjectOptions(enabled = true) {
  const { data, isLoading } = trpc.provider.listGcpProjects.useQuery(undefined, {
    staleTime: WEB_CONFIG.gcpProjectsStaleTimeMs,
    enabled,
  });
  const options = useMemo(
    () =>
      (data ?? []).map((p) => ({
        value: p.projectId,
        label: p.name ? `${p.name} (${p.projectId})` : p.projectId,
        displayLabel: p.name || p.projectId,
      })),
    [data],
  );
  return { options, isLoading };
}

/** Returns the set of LLM provider names that are configured (API key, or Vertex project). */
export function useConfiguredProviders(): Set<string> {
  const { data: anthropicKey } = trpc.settings.getApiKey.useQuery("anthropic");
  const { data: googleKey } = trpc.settings.getApiKey.useQuery("google");
  const { data: vertexConfig } = trpc.settings.getVertexConfig.useQuery();
  return useMemo(() => {
    const s = new Set<string>();
    if (anthropicKey) s.add("anthropic");
    if (googleKey) s.add("google");
    if (vertexConfig?.projectId) s.add("google-vertex");
    return s;
  }, [anthropicKey, googleKey, vertexConfig]);
}

/** Models of configured providers plus discovered Vertex models; `isLoading` covers that discovery. */
export function useAvailableModels(): {
  models: Array<{ provider: string; modelId: string }>;
  isLoading: boolean;
} {
  const configured = useConfiguredProviders();
  const vertexEnabled = configured.has("google-vertex");
  const { data: vertexModels, isLoading: vertexLoading } = trpc.provider.listVertexModels.useQuery(
    undefined,
    { enabled: vertexEnabled },
  );
  const models = useMemo(() => {
    const staticModels = AVAILABLE_MODELS.filter((m) => configured.has(m.provider));
    const vertex = vertexEnabled
      ? (vertexModels ?? []).map((m) => ({ provider: "google-vertex", modelId: m.modelId }))
      : [];
    const merged = [...staticModels, ...vertex];
    return merged.length > 0 ? merged : [...AVAILABLE_MODELS];
  }, [configured, vertexEnabled, vertexModels]);
  return { models, isLoading: vertexEnabled && vertexLoading };
}

/** File drag-and-drop; a depth counter keeps `dragActive` steady while dragging over children. */
export function useFileDrop(onFiles: (files: FileList) => void, enabled = true) {
  const [dragActive, setDragActive] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const dropProps = enabled
    ? {
        onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current += 1; setDragActive(true); },
        onDragOver: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); },
        onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragActive(false); },
        onDrop: (e: React.DragEvent) => { e.preventDefault(); depth.current = 0; setDragActive(false); if (e.dataTransfer.files?.length) onFilesRef.current(e.dataTransfer.files); },
      }
    : {};

  return { dragActive: enabled && dragActive, dropProps };
}

/** useState backed by localStorage (JSON); falls back to `initial` when storage is unavailable or unreadable. */
export function usePersistedState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValueRaw] = useState<T>(() => {
    let raw: string | null;
    try { raw = localStorage.getItem(key); } catch { return initial; }
    if (raw === null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Older builds stored plain strings unquoted.
      return typeof initial === "string" ? (raw as T) : initial;
    }
  });
  const setValue = useCallback((next: T) => {
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage unavailable */ }
    setValueRaw(next);
  }, [key]);
  return [value, setValue];
}


/**
 * Data-source status for every screen, from one shared query, so two screens never disagree.
 * A failed check repeats until it passes; `fresh` checks again on each mount.
 */
export function useProviderPings({ fresh = false } = {}) {
  const failed = (data: { ok: boolean }[] | undefined) => !!data?.some((p) => !p.ok);
  return trpc.provider.ping.useQuery(undefined, {
    refetchOnMount: (query) => (fresh || failed(query.state.data) ? "always" : true),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (failed(query.state.data) ? WEB_CONFIG.providerRetryMs : false),
  });
}

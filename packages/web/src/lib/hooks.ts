import { useMemo, useRef, useState, useEffect, useCallback, type RefObject } from "react";
import { trpc } from "./trpc";
import { AVAILABLE_MODELS } from "./models";
import { WEB_CONFIG } from "./config";

/**
 * Plain-div chat scroll — auto-follows streaming content via ResizeObserver.
 * Stops auto-scroll on deliberate upward wheel gesture; resumes when user
 * scrolls back to the bottom.
 */
export function useChatScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((opts?: { animation?: "instant" | "smooth" }) => {
    const el = scrollRef.current;
    if (!el) return;
    shouldAutoScroll.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: opts?.animation === "smooth" ? "smooth" : "instant" });
  }, []);

  const scrollToTop = useCallback((opts?: { animation?: "instant" | "smooth" }) => {
    const el = scrollRef.current;
    if (!el) return;
    shouldAutoScroll.current = false;
    el.scrollTo({ top: 0, behavior: opts?.animation === "smooth" ? "smooth" : "instant" });
  }, []);

  const handleWheel = useCallback((e: { deltaY: number }) => {
    if (e.deltaY < 0) shouldAutoScroll.current = false;
  }, []);

  // Track isAtBottom and re-enable auto-scroll when user scrolls back down
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      setIsAtBottom(atBottom);
      if (atBottom) shouldAutoScroll.current = true;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ResizeObserver on inner content div — auto-scrolls on any content growth
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (shouldAutoScroll.current) scrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  return { scrollRef, contentRef, isAtBottom, handleWheel, scrollToBottom, scrollToTop };
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
      if (rect && rect.width > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
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
) {
  const callbackRef = useRef(invalidate);
  callbackRef.current = invalidate;

  useEffect(() => {
    if (!enabled) return;
    callbackRef.current();
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
  }, [enabled, intervalMs]);
}

/** Track whether a scrollable element can scroll up/down, for fade indicators */
export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      setShowTopFade(el.scrollTop > 0);
      setShowBottomFade(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, [ref]);

  return { showTopFade, showBottomFade };
}

/**
 * Polled gcloud ADC auth status, shared (react-query dedups the key) by the GCP provider's
 * project selector and the Vertex card so an expired/missing session surfaces on its own.
 */
export function useGcpAuthStatus() {
  return trpc.provider.gcpAuthStatus.useQuery(undefined, {
    refetchInterval: WEB_CONFIG.sessionStaleTimeMs,
    staleTime: WEB_CONFIG.sessionStaleTimeMs,
  });
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

/**
 * Selectable models filtered to configured providers (falls back to all). Vertex models
 * are discovered dynamically from the configured project and merged with the static list.
 * `isLoading` is true while that discovery is in flight, so callers can avoid acting on the
 * interim list (e.g. resetting a saved Vertex selection that hasn't been discovered yet).
 */
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
    return merged.length > 0 ? merged : AVAILABLE_MODELS;
  }, [configured, vertexEnabled, vertexModels]);
  return { models, isLoading: vertexEnabled && vertexLoading };
}

/**
 * File drag-and-drop onto an element. Returns `dragActive` (true while files are
 * dragged over) and `dropProps` to spread on the drop target. A depth counter
 * keeps `dragActive` stable as the cursor crosses child elements (enter/leave
 * bubble), so the highlight doesn't flicker. Pass `enabled = false` to disable.
 */
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

/** Calls callback when a click occurs outside the referenced element. */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  callback: () => void,
): void {
  // Stable ref so the effect never re-runs just because an inline lambda was recreated
  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; });

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callbackRef.current();
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [ref]);
}

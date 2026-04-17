import { useMemo, useRef, useState, useEffect, useCallback, type RefObject } from "react";
import { trpc } from "./trpc";
import { AVAILABLE_MODELS } from "./models";

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

/** Returns the set of LLM provider names that have an API key configured. */
export function useConfiguredProviders(): Set<string> {
  const { data: anthropicKey } = trpc.settings.getApiKey.useQuery("anthropic");
  const { data: googleKey } = trpc.settings.getApiKey.useQuery("google");
  return useMemo(() => {
    const s = new Set<string>();
    if (anthropicKey) s.add("anthropic");
    if (googleKey) s.add("google");
    return s;
  }, [anthropicKey, googleKey]);
}

/** Returns AVAILABLE_MODELS filtered to only configured providers (falls back to all). */
export function useAvailableModels() {
  const configured = useConfiguredProviders();
  return useMemo(() => {
    const filtered = AVAILABLE_MODELS.filter((m) => configured.has(m.provider));
    return filtered.length > 0 ? filtered : AVAILABLE_MODELS;
  }, [configured]);
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

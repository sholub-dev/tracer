import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { cn } from "@/lib/utils";

const SELECTOR = 'section[aria-label="Analysis"]';
// Keeps the target clear of the sticky session header.
const TOP_OFFSET = 56;

/** Phone-only tabs on the right edge; each one scrolls the transcript to one analysis summary. */
export function SummaryTabs({ scrollRef, contentRef }: { scrollRef: RefObject<HTMLDivElement | null>; contentRef: RefObject<HTMLDivElement | null> }) {
  const [sections, setSections] = useState<HTMLElement[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const sync = () => {
      const next = Array.from(content.querySelectorAll<HTMLElement>(SELECTOR));
      setSections((prev) => (prev.length === next.length && prev.every((el, i) => el === next[i]) ? prev : next));
    };
    sync();
    // A streaming reply mutates the DOM on every token; one scan per frame is enough.
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); });
    });
    mo.observe(content, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [contentRef]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || sections.length === 0) return;
    const visible = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        const i = sections.findIndex((el) => visible.has(el));
        if (i >= 0) setActive(i);
      },
      { root, rootMargin: `-${TOP_OFFSET}px 0px -40% 0px` },
    );
    for (const el of sections) io.observe(el);
    return () => io.disconnect();
  }, [scrollRef, sections]);

  if (sections.length < 2) return null;

  const go = (el: HTMLElement) => {
    const root = scrollRef.current;
    if (!root) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - TOP_OFFSET;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: Math.max(0, top), behavior: reduce ? "instant" : "smooth" });
  };

  return (
    <nav aria-label="Summaries" className="absolute top-1/2 right-0 z-10 flex -translate-y-1/2 flex-col gap-1.5 sm:hidden">
      {sections.map((el, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Go to summary ${i + 1}`}
          aria-current={i === active ? "true" : undefined}
          onClick={() => go(el)}
          className={cn(
            "flex h-7 w-5 items-center justify-center rounded-l-md border border-r-0 text-[11px] leading-none font-medium tabular-nums shadow-sm",
            i === active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground",
          )}
        >
          {i + 1}
        </button>
      ))}
    </nav>
  );
}

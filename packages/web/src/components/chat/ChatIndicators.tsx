import type React from "react";

/** Animated bouncing dots shown while waiting for a response. */
export function ThinkingDots({ className }: { className: string }) {
  return (
    <div className={className}>
      <span className="inline-flex items-center gap-1">
        {THINKING_DELAYS.map((delay) => (
          <span
            key={delay}
            className="inline-block w-1.5 h-1.5 rounded-full bg-current"
            style={THINKING_DOT_STYLES[delay]}
          />
        ))}
      </span>
    </div>
  );
}
const THINKING_DELAYS = [0, 150, 300] as const;
const THINKING_DOT_STYLES: Record<number, React.CSSProperties> = {
  0:   { animation: "dot-bounce 1.2s ease-in-out infinite", animationDelay: "0ms" },
  150: { animation: "dot-bounce 1.2s ease-in-out infinite", animationDelay: "150ms" },
  300: { animation: "dot-bounce 1.2s ease-in-out infinite", animationDelay: "300ms" },
};

/**
 * Floating button that appears when the user scrolls away from the bottom.
 */
export function ScrollToBottomButton({
  isAtBottom,
  scrollToBottom,
}: {
  isAtBottom: boolean;
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void;
}) {
  if (isAtBottom) return null;

  return (
    <button
      type="button"
      onClick={() => scrollToBottom({ animation: "instant" })}
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 bg-[#2b5ea7] text-white rounded-full p-2 shadow-lg hover:bg-[#1e4a8a] transition-colors"
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

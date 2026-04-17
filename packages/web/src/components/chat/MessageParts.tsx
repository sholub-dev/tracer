import React, { useRef, useCallback, useState } from "react";
import { Streamdown } from "streamdown";
import { domToPng } from "modern-screenshot";
import { CLIENT_TOOL_NAMES } from "@oko/shared";
import { ToolPartRenderer } from "./ToolPartRenderer";
import type { ProgressStore } from "../../lib/progress-store";
import { theme } from "../../lib/theme";
import type { UIMessage } from "ai";
import { CopyMessageButton } from "./CopyMessageButton";
import { encodePngWithPayload } from "../../lib/png-steg";

interface MessagePartsProps {
  parts: UIMessage["parts"];
  isAnimating: boolean;
  progressStore: ProgressStore;
  sourceTitle?: string;
  sourceCreatedAt?: number;
  resolveSourceTitle?: () => Promise<string | undefined>;
}

/** Marker the agent writes to signal "analysis starts here". Stripped from display. */
export const ANALYSIS_MARKER = "<analysis>";

/** Analysis container with its own copy/download buttons. */
function AnalysisSection({
  parts,
  children,
  sourceTitle,
  sourceCreatedAt,
  resolveSourceTitle,
}: {
  parts: UIMessage["parts"];
  children: React.ReactNode;
  sourceTitle?: string;
  sourceCreatedAt?: number;
  resolveSourceTitle?: () => Promise<string | undefined>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      const dataUrl = await domToPng(el, { scale: 2 });
      const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());

      // Resolve the freshest title at click time — session titles are generated
      // asynchronously after the first response and the prop may still hold
      // "New chat" for a moment after the stream ends.
      const resolvedTitle = (await resolveSourceTitle?.()) ?? sourceTitle ?? "";

      // Carry all parts from the analysis slice as-is: text, reasoning, and
      // tool invocations (with their inputs and outputs) so charts, tables,
      // and sub-agent results render on re-import. The begin_analysis marker
      // has already been excluded by the slicing logic above.
      const payload = JSON.stringify({
        v: 1,
        kind: "analysis",
        sourceTitle: resolvedTitle,
        sourceCreatedAt: sourceCreatedAt ?? Math.floor(Date.now() / 1000),
        parts,
      });

      if (payload.length > 2 * 1024 * 1024) {
        setDownloadError("Analysis too large to embed metadata");
        setTimeout(() => setDownloadError(null), 2500);
        return;
      }

      const out = await encodePngWithPayload(bytes, new TextEncoder().encode(payload));
      const blob = new Blob([out.buffer as ArrayBuffer], { type: "image/png" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const now = new Date();
      const stamp = `${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
      a.download = `analysis-${stamp}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      // Silent fail — domToPng or chunk write not supported
    }
  }, [parts, sourceTitle, sourceCreatedAt, resolveSourceTitle]);

  return (
    <div ref={containerRef} className={`${theme.analysisContainer} relative group/analysis`}>
      <div className="flex items-center justify-between mb-1">
        <div className={theme.summaryLabel}>Analysis</div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover/analysis:opacity-100 transition-opacity">
          {downloadError && (
            <span className="text-[10px] text-[#b33a2a] mr-1">{downloadError}</span>
          )}
          <CopyMessageButton contentRef={containerRef} parts={parts} size={12} />
          <button
            type="button"
            onClick={handleDownload}
            className={theme.chatActionButton}
            title="Download as image"
            aria-label="Download as image"
          >
            <DownloadIcon size={12} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

function DownloadIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export const MessageParts = React.memo(
  function MessageParts({ parts, isAnimating, progressStore, sourceTitle, sourceCreatedAt, resolveSourceTitle }: MessagePartsProps) {
    if (parts.length === 0 && !isAnimating) {
      return <span className="text-sm italic text-[#9c9890]">(interrupted)</span>;
    }

    type AnalysisMarker =
      | { kind: "tool"; partIdx: number }
      | { kind: "text"; partIdx: number; charIdx: number };

    let marker: AnalysisMarker | null = null;

    // Priority 1: tool-based marker (begin_analysis tool call)
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS) {
        marker = { kind: "tool", partIdx: i };
        break;
      }
    }

    // Priority 2: text-based marker (backward compat)
    if (!marker) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.type === "text") {
          const idx = p.text.indexOf(ANALYSIS_MARKER);
          if (idx !== -1) {
            marker = { kind: "text", partIdx: i, charIdx: idx };
            break;
          }
        }
      }
    }

    function renderPart(part: UIMessage["parts"][number], i: number | string, textOverride?: string) {
      if (part.type === "reasoning") {
        return (
          <details key={i} className="mb-2 border border-[#e8e3da]/30 rounded-md">
            <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-[#9c9890] italic hover:text-[#6b6560] transition-colors">
              Thinking
            </summary>
            <div className="px-3 pb-2 text-sm text-[#9c9890] italic">
              <Streamdown isAnimating={isAnimating} controls={{ code: true }} linkSafety={{ enabled: false }}>{part.text}</Streamdown>
            </div>
          </details>
        );
      }
      if (part.type === "text") {
        const text = textOverride ?? part.text;
        if (!text.trim()) return null;
        return (
          <Streamdown key={i} isAnimating={isAnimating} controls={{ code: true }} linkSafety={{ enabled: false }}>
            {text}
          </Streamdown>
        );
      }
      return (
        <ToolPartRenderer
          key={i}
          part={part as Parameters<typeof ToolPartRenderer>[0]["part"]}
          progressStore={progressStore}
        />
      );
    }

    if (!marker) {
      return <>{parts.map((part, i) => renderPart(part, i))}</>;
    }

    const before: React.ReactNode[] = [];
    const after: React.ReactNode[] = [];

    for (let i = 0; i < parts.length; i++) {
      if (i < marker.partIdx) {
        before.push(renderPart(parts[i], i));
      } else if (i === marker.partIdx) {
        if (marker.kind === "text") {
          const markerPart = parts[i] as { type: "text"; text: string };
          const textBefore = markerPart.text.slice(0, marker.charIdx);
          const textAfter = markerPart.text.slice(marker.charIdx + ANALYSIS_MARKER.length);
          if (textBefore.trim()) before.push(renderPart(parts[i], i, textBefore));
          if (textAfter.trim()) after.push(renderPart(parts[i], `${i}-after`, textAfter));
        }
        // tool-based marker: entire part is the marker, skip it
      } else {
        after.push(renderPart(parts[i], i));
      }
    }

    // Build a parts slice for the analysis section (for CopyMessageButton)
    const analysisParts: UIMessage["parts"] = [];
    for (let i = marker.partIdx; i < parts.length; i++) {
      const p = parts[i];
      if (i === marker.partIdx) {
        if (marker.kind === "text" && p.type === "text") {
          const textAfter = p.text.slice(marker.charIdx + ANALYSIS_MARKER.length);
          if (textAfter.trim()) analysisParts.push({ type: "text", text: textAfter });
        }
      } else {
        analysisParts.push(p);
      }
    }

    return (
      <>
        {before}
        <AnalysisSection parts={analysisParts} sourceTitle={sourceTitle} sourceCreatedAt={sourceCreatedAt} resolveSourceTitle={resolveSourceTitle}>
          {after}
        </AnalysisSection>
      </>
    );
  },
  (prev, next) => {
    // Always re-render streaming messages (content is changing)
    if (prev.isAnimating || next.isAnimating) return false;
    // Source metadata feeds the "download as image" payload — a late-arriving
    // title must trigger a re-render so the AnalysisSection closure sees it.
    if (prev.sourceTitle !== next.sourceTitle) return false;
    if (prev.sourceCreatedAt !== next.sourceCreatedAt) return false;
    // Completed messages: parts are stable, skip re-render
    if (prev.parts === next.parts) return true;
    // When a tool part transitions state (e.g. input-available → output-available),
    // the array length stays the same but the part object is a new reference.
    if (prev.parts.length !== next.parts.length) return false;
    for (let i = 0; i < prev.parts.length; i++) {
      if (prev.parts[i] !== next.parts[i]) return false;
    }
    return true;
  },
);

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

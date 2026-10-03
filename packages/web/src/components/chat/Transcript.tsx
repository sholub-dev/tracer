import type { ReactNode, RefObject } from "react";
import { cn } from "@/lib/utils";
import { normalizeClipboard } from "../../lib/chat-utils";
import { ScrollToBottomButton } from "./ChatIndicators";

/** Centered reading column shared by the transcript, the dock and the session header. */
export const COLUMN = "mx-auto w-full max-w-[808px] px-4 sm:px-6";

interface TranscriptProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void;
  /** Rendered first inside the scroll container (e.g. the sticky session header). */
  header?: ReactNode;
  compact?: boolean;
  children: ReactNode;
  /** Pinned under the scroll area: timer bar and composer. */
  dock: ReactNode;
}

/** Scrolling message column with the composer dock below it; place inside a flex column. */
export function Transcript({ scrollRef, contentRef, isAtBottom, scrollToBottom, header, compact = false, children, dock }: TranscriptProps) {
  const column = compact ? "w-full px-5" : COLUMN;
  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-x-hidden overflow-y-auto" onCopy={normalizeClipboard}>
          <div ref={contentRef} className="flex min-h-full flex-col bg-background">
            {header}
            <div className={cn(column, "flex-1 space-y-8 pb-10", compact ? "pt-5" : "pt-6")}>{children}</div>
          </div>
        </div>
      </div>
      <div className="relative z-10 bg-background before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-10 before:bg-linear-to-t before:from-background before:to-transparent">
        <ScrollToBottomButton isAtBottom={isAtBottom} scrollToBottom={scrollToBottom} />
        <div className={cn(column, compact ? "pt-1 pb-3" : "pt-1 pb-4")}>{dock}</div>
      </div>
    </>
  );
}

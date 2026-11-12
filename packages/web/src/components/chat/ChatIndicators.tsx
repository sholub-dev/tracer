import { cn } from "@/lib/utils";
import { ArrowDown } from "lucide-react";
import { IconButton } from "../common/IconButton";

/** Three dots that pulse in turn; transform and opacity only, so it stays smooth on phones. */
export function LoadingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex items-center gap-[3px]", className)}>
      <span className="loading-dot" />
      <span className="loading-dot [animation-delay:160ms]" />
      <span className="loading-dot [animation-delay:320ms]" />
    </span>
  );
}

/** The loading indicator at the tail of a running reply; the slot keeps its height when the label comes and goes. */
export function ActivityLine({ label }: { label: string | null }) {
  return (
    <p role="status" className="-mt-4 flex h-[18px] items-center gap-2 text-[13px]/[18px] text-muted-foreground">
      {label && (
        <>
          <LoadingDots />
          <span>{label}</span>
        </>
      )}
    </p>
  );
}

export function ScrollToBottomButton({
  isAtBottom,
  scrollToBottom,
}: {
  isAtBottom: boolean;
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void;
}) {
  if (isAtBottom) return null;
  return (
    <IconButton
      label="Scroll to bottom"
      variant="outline"
      className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-full bg-card shadow-sm animate-in fade-in duration-150"
      onClick={() => scrollToBottom({ animation: "instant" })}
    >
      <ArrowDown />
    </IconButton>
  );
}

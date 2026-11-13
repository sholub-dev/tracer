import { ArrowDown } from "lucide-react";
import { IconButton } from "../common/IconButton";

const DOT_DELAYS = ["0ms", "200ms", "400ms"];

/** The one animated element at the tail of a running reply. It stays mounted for the whole run, so its animation never restarts. */
export function ActivityLine({ active = true }: { active?: boolean }) {
  return (
    <div role="status" className="-mt-4 flex h-[18px] items-center gap-1">
      {active && <span className="sr-only">Working</span>}
      {active && DOT_DELAYS.map((delay) => <span key={delay} className="size-1.5 animate-pulse-dot rounded-full bg-muted-foreground" style={{ animationDelay: delay }} />)}
    </div>
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

import { ArrowDown } from "lucide-react";
import { IconButton } from "../common/IconButton";

/** The one animated element at the tail of a running reply; the slot keeps its height when the label comes and goes. */
export function ActivityLine({ label }: { label: string | null }) {
  return (
    <p role="status" className="-mt-4 h-[18px] text-[13px]/[18px] text-muted-foreground">
      {label && <span className="animate-shimmer">{label}</span>}
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

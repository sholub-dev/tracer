import { ArrowDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "../common/IconButton";

export function WorkingIndicator({ label = "Working", className }: { label?: string; className?: string }) {
  return (
    <p role="status" className={cn("flex items-center gap-2 text-[13px]/[18px] text-muted-foreground", className)}>
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {label}
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

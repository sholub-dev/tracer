import type { ComponentProps } from "react";
import { ChevronRight } from "lucide-react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type FoldTriggerProps = ComponentProps<typeof CollapsibleTrigger> & { chevronClassName?: string; chevronEnd?: boolean };

/** Collapsible trigger with a chevron that turns when open. */
export function FoldTrigger({ className, chevronClassName, chevronEnd = false, children, ...props }: FoldTriggerProps) {
  const chevron = (
    <ChevronRight
      className={cn("size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-90", chevronClassName)}
      aria-hidden="true"
    />
  );
  return (
    <CollapsibleTrigger className={cn("group/trigger outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)} {...props}>
      {!chevronEnd && chevron}
      {children}
      {chevronEnd && chevron}
    </CollapsibleTrigger>
  );
}

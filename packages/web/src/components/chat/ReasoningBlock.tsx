import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { Streamdown } from "streamdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MD_CONTROLS, MD_LINK_SAFETY } from "../../lib/markdown";

/** Model reasoning, collapsed by default; the body only renders while open. */
export const ReasoningBlock = memo(function ReasoningBlock({ content, isAnimating }: { content: string; isAnimating: boolean }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group/trigger -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px]/[18px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-90" aria-hidden="true" />
        Thinking
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-w-[68ch] pl-5 text-sm leading-relaxed text-muted-foreground">
          <Streamdown isAnimating={isAnimating} controls={MD_CONTROLS} linkSafety={MD_LINK_SAFETY}>{content}</Streamdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

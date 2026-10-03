import { memo } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Markdown } from "../../lib/markdown";
import { FoldTrigger } from "../common/FoldTrigger";

/** Model reasoning, collapsed by default; the body only renders while open. */
export const ReasoningBlock = memo(function ReasoningBlock({ content, isAnimating }: { content: string; isAnimating: boolean }) {
  return (
    <Collapsible>
      <FoldTrigger className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px]/[18px] text-muted-foreground transition-colors hover:text-foreground">
        Thinking
      </FoldTrigger>
      <CollapsibleContent>
        <Markdown text={content} isAnimating={isAnimating} className="mt-1 max-w-[68ch] pl-5 text-sm leading-relaxed text-muted-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
});

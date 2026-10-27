import { memo } from "react";
import { Loader2 } from "lucide-react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Markdown } from "../../lib/markdown";
import { FoldTrigger } from "../common/FoldTrigger";

/** Model reasoning, collapsed by default; the body only renders while open. */
// While it streams the block is the only sign of progress, since the working indicator hides during content.
export const ReasoningBlock = memo(function ReasoningBlock({ content, isAnimating, streaming = false }: { content: string; isAnimating: boolean; streaming?: boolean }) {
  return (
    <Collapsible>
      <FoldTrigger className="-ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px]/[18px] text-muted-foreground transition-colors hover:text-foreground">
        {streaming ? "Thinking…" : "Thinking"}
        {streaming && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
      </FoldTrigger>
      <CollapsibleContent>
        <Markdown text={content} isAnimating={isAnimating} className="mt-1 max-w-[68ch] pl-5 text-sm leading-relaxed text-muted-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
});

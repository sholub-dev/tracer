import { memo } from "react";
import { Streamdown } from "streamdown";

/**
 * Collapsible "Thinking" block for model reasoning. Single source of truth shared
 * by the top-level message renderer (MessageParts) and the sub-agent renderer
 * (ToolPartRenderer) so reasoning renders identically everywhere — collapsed by
 * default; the user expands it on demand.
 */
export const ReasoningBlock = memo(function ReasoningBlock({
  content,
  isAnimating,
}: {
  content: string;
  isAnimating: boolean;
}) {
  return (
    <details className="mb-2 border border-[#e8e3da]/30 rounded-md">
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-[#9c9890] italic hover:text-[#6b6560] transition-colors">
        Thinking
      </summary>
      <div className="px-3 pb-2 text-sm text-[#9c9890] italic">
        <Streamdown isAnimating={isAnimating} controls={{ code: true }} linkSafety={{ enabled: false }}>{content}</Streamdown>
      </div>
    </details>
  );
});

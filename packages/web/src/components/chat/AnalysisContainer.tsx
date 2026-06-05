import type { ReactNode, Ref } from "react";
import { theme } from "../../lib/theme";

/**
 * The distinct blue "Analysis" box. Single source of truth shared by the top-level
 * message renderer (MessageParts → AnalysisSection, which passes copy/download buttons
 * via `actions`) and the provider query-tool renderer (ToolPartRenderer), so the Analysis
 * looks identical wherever it appears.
 */
export function AnalysisContainer({
  children,
  actions,
  containerRef,
}: {
  children: ReactNode;
  actions?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={containerRef} className={`${theme.analysisContainer} relative group/analysis`}>
      <div className="flex items-center justify-between mb-1">
        <div className={theme.summaryLabel}>Analysis</div>
        {actions}
      </div>
      {children}
    </div>
  );
}

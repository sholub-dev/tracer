import { useState, useRef } from "react";
import { useClickOutside } from "../../lib/hooks";
import { theme } from "../../lib/theme";
import { computeCost, formatCost } from "../../lib/models";
import { ProviderToggle } from "../ui/ProviderToggle";

export interface AgentCost {
  label: string;
  model: string | null;
  cost: number;
}

export interface CostBreakdown {
  agents: AgentCost[];
  totalCost: number;
  totalCostWithoutCache: number;
  totalInput: number;
  totalOutput: number;
  totalCached: number;
}

/** Convert server-side agent token breakdown into client-side cost breakdown. */
export function computeCostBreakdown(agents: Array<{ label: string; model: string | null; input: number; output: number; cached: number; cacheWrite: number; reasoning: number }>): CostBreakdown {
  const costed: AgentCost[] = agents.map((a) => ({
    label: a.label,
    model: a.model,
    cost: computeCost(a.model, a.input, a.output, a.cached, a.cacheWrite),
  }));
  let totalInput = 0, totalOutput = 0, totalCached = 0;
  for (const a of agents) { totalInput += a.input; totalOutput += a.output; totalCached += a.cached; }
  const totalCost = costed.reduce((sum, a) => sum + a.cost, 0);
  // Cost without cache discount — for showing savings
  const totalCostWithoutCache = agents.reduce((sum, a) => sum + computeCost(a.model, a.input, a.output, 0, 0), 0);
  return {
    agents: costed,
    totalCost,
    totalCostWithoutCache,
    totalInput,
    totalOutput,
    totalCached,
  };
}

export function CostDisplay({ breakdown, activeProvider, onToggle }: {
  breakdown: CostBreakdown;
  activeProvider: string | null;
  onToggle: (type: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setHover(false));

  return (
    <div className="relative px-10 pt-2" ref={ref}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          className={theme.tokenSummary}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={() => setHover((v) => !v)}
        >
          {breakdown.totalInput.toLocaleString()} in &middot; {breakdown.totalOutput.toLocaleString()} out
          {breakdown.totalCost > 0 && <> &middot; {formatCost(breakdown.totalCost)}</>}
        </button>
        <ProviderToggle activeProvider={activeProvider} onToggle={onToggle} />
      </div>
      {hover && breakdown.agents.length > 0 && (
        <div className={`bottom-full left-10 mb-1 ${theme.popoverWide}`}>
          <div className={theme.popoverLabel}>Cost Breakdown</div>
          {breakdown.agents.map((a, i) => (
            <div key={i} className={theme.popoverItemRow}>
              <span className="truncate mr-2">
                {a.label}
                {a.model && <span className="text-[#9c9890] ml-1">({a.model})</span>}
              </span>
              <span className="shrink-0 tabular-nums">{formatCost(a.cost)}</span>
            </div>
          ))}
          {breakdown.agents.length > 1 && (
            <>
              <div className={theme.popoverDivider} />
              <div className="flex items-center justify-between text-[11px] text-[#4a4540] font-sans font-medium">
                <span>Total</span>
                <span className="tabular-nums">{formatCost(breakdown.totalCost)}</span>
              </div>
            </>
          )}
          {breakdown.totalCached > 0 && (
            <div className={theme.popoverFootnote}>
              {breakdown.totalCached.toLocaleString()} cached tokens
              {breakdown.totalCostWithoutCache > breakdown.totalCost && (
                <> &middot; saved {formatCost(breakdown.totalCostWithoutCache - breakdown.totalCost)}</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

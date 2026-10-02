import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { computeCost, formatCost } from "../../lib/models";

interface AgentCost {
  label: string;
  model: string | null;
  cost: number;
}

interface CostBreakdown {
  agents: AgentCost[];
  totalCost: number;
  totalCostWithoutCache: number;
  totalInput: number;
  totalOutput: number;
  totalCached: number;
}

/** Prices each agent's tokens at `atMs`, so a later price change never rewrites past costs. */
export function computeCostBreakdown(agents: Array<{ label: string; model: string | null; input: number; output: number; cached: number; cacheWrite: number; reasoning: number }>, atMs?: number): CostBreakdown {
  const costed: AgentCost[] = agents.map((a) => ({
    label: a.label,
    model: a.model,
    cost: computeCost(a.model, a.input, a.output, a.cached, a.cacheWrite, atMs),
  }));
  let totalInput = 0, totalOutput = 0, totalCached = 0;
  for (const a of agents) { totalInput += a.input; totalOutput += a.output; totalCached += a.cached; }
  return {
    agents: costed,
    totalCost: costed.reduce((sum, a) => sum + a.cost, 0),
    totalCostWithoutCache: agents.reduce((sum, a) => sum + computeCost(a.model, a.input, a.output, 0, 0, atMs), 0),
    totalInput,
    totalOutput,
    totalCached,
  };
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export function CostDisplay({ breakdown }: { breakdown: CostBreakdown }) {
  const tokens = compact.format(breakdown.totalInput + breakdown.totalOutput);
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="hidden h-7 shrink-0 rounded-md px-1.5 text-xs text-muted-foreground tabular-nums transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:inline-flex sm:items-center"
        >
          {tokens} tokens{breakdown.totalCost > 0 && <> · {formatCost(breakdown.totalCost)}</>}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-80">
        <p className="mb-3 text-sm font-semibold">Cost for this investigation</p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[13px]/[18px] tabular-nums">
          {breakdown.agents.map((a, i) => (
            <div key={i} className="contents">
              <dt className="min-w-0 truncate text-ink-2">
                {a.label}
                {a.model && <span className="text-muted-foreground"> · {a.model}</span>}
              </dt>
              <dd className="text-right">{formatCost(a.cost)}</dd>
            </div>
          ))}
          <div className="contents font-semibold">
            <dt className="mt-1 border-t pt-2">Total</dt>
            <dd className="mt-1 border-t pt-2 text-right">{formatCost(breakdown.totalCost)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground tabular-nums">
          {breakdown.totalInput.toLocaleString()} in · {breakdown.totalOutput.toLocaleString()} out
          {breakdown.totalCached > 0 && <> · {breakdown.totalCached.toLocaleString()} cached</>}
          {breakdown.totalCostWithoutCache > breakdown.totalCost && <> · saved {formatCost(breakdown.totalCostWithoutCache - breakdown.totalCost)}</>}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

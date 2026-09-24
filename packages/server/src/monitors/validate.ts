import { substituteWindow, unixNow } from "@tracer-sh/shared";
import type { ProviderRegistry } from "../providers/registry.js";
import { CONFIG } from "../config.js";
import { requireTimeRangePlaceholders } from "../tools/query-validation.js";
import { toChartRows } from "../providers/posthog/posthog-formatter.js";
import { evaluateCondition, extractGroups, parseCondition, sumGroups, type Condition, type Group } from "./condition.js";

export const MONITOR_PROVIDERS = ["newrelic", "posthog"] as const;
export type MonitorProvider = (typeof MONITOR_PROVIDERS)[number];

const PROVIDER_LABELS: Record<MonitorProvider, string> = { newrelic: "New Relic", posthog: "PostHog" };
const CHART_VALIDATION_SECONDS = 86_400;

export interface MonitorDraft {
  provider: string;
  query: string;
  chartQuery?: string | null;
  condition: string;
  frequencySeconds: number;
}

export function normalizeDraft<T extends MonitorDraft>(draft: T): T & { chartQuery: string | null } {
  return {
    ...draft,
    chartQuery: draft.provider === "posthog" ? draft.chartQuery ?? null : null,
    frequencySeconds: Math.round(draft.frequencySeconds),
  };
}

export interface ValidationResult {
  condition: Condition;
  sampleValue?: number;
  groups?: Group[];
  wouldTrigger?: boolean;
}

const BANNED_CLAUSES: Array<[RegExp, string]> = [
  [/\bTIMESERIES\b/i, "TIMESERIES"],
  [/\bCOMPARE\s+WITH\b/i, "COMPARE WITH"],
];

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function validateChartQuery(
  provider: { executeRawQuery(query: string): Promise<unknown> },
  chartQuery: string,
  end: number,
): Promise<string | null> {
  let rows: unknown;
  try {
    rows = await withTimeout(
      provider.executeRawQuery(substituteWindow("posthog", chartQuery, end - CHART_VALIDATION_SECONDS, end)),
      CONFIG.monitorQueryTimeoutMs,
      "monitor chart validation",
    );
  } catch (err) {
    return `chartQuery failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  // Fewer than two rows cannot be recognized as a timeseries, so only larger results are shape-checked.
  if (Array.isArray(rows) && rows.length >= 2 && !("beginTimeSeconds" in (toChartRows(rows)[0] ?? {}))) {
    return "chartQuery must return a time bucket column (toStartOfInterval(timestamp, INTERVAL ...) AS bucket), numeric counts, and at most one group column.";
  }
  return null;
}

export async function validateMonitor(
  providers: ProviderRegistry,
  draft: MonitorDraft,
  opts: { runQuery?: boolean } = {},
): Promise<ValidationResult | { error: string }> {
  if (!(MONITOR_PROVIDERS as readonly string[]).includes(draft.provider)) {
    return { error: `Unsupported monitor provider "${draft.provider}". Use one of: ${MONITOR_PROVIDERS.join(", ")}.` };
  }
  const providerName = draft.provider as MonitorProvider;
  const placeholderError = requireTimeRangePlaceholders(draft.query);
  if (placeholderError) return placeholderError;
  if (providerName === "newrelic") {
    for (const [re, label] of BANNED_CLAUSES) {
      if (re.test(draft.query)) return { error: `Query must not use ${label}; it must return one count per group.` };
    }
  } else {
    if (!draft.chartQuery) return { error: "PostHog monitors need a chartQuery: a HogQL timeseries of the same metric." };
    if (requireTimeRangePlaceholders(draft.chartQuery)) {
      return { error: "chartQuery must contain {{SINCE}} and {{UNTIL}}: timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}})." };
    }
  }
  const condition = parseCondition(draft.condition);
  if (!condition) {
    return { error: `Invalid condition "${draft.condition}". Use an operator (> >= < <= == !=) and a number, e.g. "> 0".` };
  }
  if (!Number.isFinite(draft.frequencySeconds) || draft.frequencySeconds < CONFIG.monitorMinFrequencySeconds) {
    return { error: `Frequency must be at least ${CONFIG.monitorMinFrequencySeconds} seconds.` };
  }
  if (!opts.runQuery) return { condition };

  const provider = providers.getProvider(providerName);
  if (!provider?.connected) return { error: `${PROVIDER_LABELS[providerName]} is not connected.` };

  const end = unixNow() - CONFIG.monitorIngestLagSeconds;
  const start = end - draft.frequencySeconds;
  let result: unknown;
  try {
    result = await withTimeout(
      provider.executeRawQuery(substituteWindow(providerName, draft.query, start, end)),
      CONFIG.monitorQueryTimeoutMs,
      "monitor validation",
    );
  } catch (err) {
    return { error: `Query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (providerName === "posthog" && draft.chartQuery) {
    const chartError = await validateChartQuery(provider, draft.chartQuery, end);
    if (chartError) return { error: chartError };
  }
  const groups = extractGroups(result, providerName);
  const sampleValue = sumGroups(groups);
  return { condition, sampleValue, groups, wouldTrigger: evaluateCondition(condition, sampleValue) };
}

import type { KnownModelId } from "@tracer-sh/shared";

interface ModelInfo {
  provider: string;
  modelId: KnownModelId;
  inputPrice: number;            // $/M tokens
  outputPrice: number;           // $/M tokens
  cacheReadMultiplier: number;   // fraction of inputPrice charged for cached reads
  cacheWriteMultiplier: number;  // fraction of inputPrice charged for cache writes
}

/** A provider + model pair, the unit of model selection across the UI. */
export interface ModelRef {
  provider: string;
  modelId: string;
}

export const modelKey = (m: ModelRef): string => `${m.provider}:${m.modelId}`;

/** Human labels for the LLM providers (the `provider` field of a ModelRef). */
export const LLM_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  google: "Google AI",
  "google-vertex": "Vertex AI",
};

export function providerLabel(provider: string): string {
  return LLM_PROVIDER_LABELS[provider] ?? provider;
}

const PROVIDER_ORDER = ["anthropic", "google", "google-vertex"];

/** Group models by provider for grouped dropdowns, in a stable, known order. */
export function groupModelsByProvider(
  models: ModelRef[],
): Array<{ provider: string; label: string; models: ModelRef[] }> {
  const byProvider = new Map<string, ModelRef[]>();
  for (const m of models) {
    const arr = byProvider.get(m.provider);
    if (arr) arr.push(m);
    else byProvider.set(m.provider, [m]);
  }
  return [...byProvider.keys()]
    .sort((a, b) => {
      const ia = PROVIDER_ORDER.indexOf(a);
      const ib = PROVIDER_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map((provider) => ({ provider, label: providerLabel(provider), models: byProvider.get(provider)! }));
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  // Google — 75% discount on cache reads, cache writes at full input price
  { provider: "google",    modelId: "gemini-3.1-pro-preview",     inputPrice: 2.00,  outputPrice: 12.00, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  { provider: "google",    modelId: "gemini-3.5-flash",           inputPrice: 1.50,  outputPrice: 9.00,  cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  { provider: "google",    modelId: "gemini-3-flash-preview",     inputPrice: 0.50,  outputPrice: 3.00,  cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  { provider: "google",    modelId: "gemini-3.1-flash-lite-preview", inputPrice: 0.25, outputPrice: 1.50, cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1.0 },
  // Anthropic — 90% discount on cache reads, 25% surcharge on cache writes
  { provider: "anthropic", modelId: "claude-haiku-4-5-20251001",  inputPrice: 0.80,  outputPrice: 4.00,  cacheReadMultiplier: 0.10, cacheWriteMultiplier: 1.25 },
];

// Build lookup for cost computation
const pricingLookup = Object.fromEntries(
  AVAILABLE_MODELS.map(m => [m.modelId, {
    input: m.inputPrice,
    output: m.outputPrice,
    cacheRead: m.cacheReadMultiplier,
    cacheWrite: m.cacheWriteMultiplier,
  }])
);

export function computeCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheWriteTokens = 0,
): number {
  if (!model) return 0;
  const p = pricingLookup[model];
  if (!p) return 0;
  const nonCachedInput = inputTokens - cachedInputTokens;
  return (
    nonCachedInput * p.input +
    cachedInputTokens * p.input * p.cacheRead +
    cacheWriteTokens * p.input * p.cacheWrite +
    outputTokens * p.output
  ) / 1_000_000;
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

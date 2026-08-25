import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import type { LanguageModel, streamText } from "ai";
import { readProviderConfig, readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/client.js";
import { CONFIG, DEFAULTS, SETTINGS_KEYS, type ModelConfig } from "../config.js";

export type { ModelConfig };
export type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

type ModelBuilder = (modelId: string) => LanguageModel;

/**
 * Each factory receives the provider's stored config record and returns a model
 * builder, or an error if required credentials are missing. API-key providers read
 * `apiKey`; Vertex reads `projectId`/`location` and authenticates via gcloud ADC.
 */
const LLM_FACTORIES: Record<string, (config: Record<string, string> | null) => ModelBuilder | { error: string }> = {
  anthropic: (config) => {
    if (!config?.apiKey) return { error: "anthropic API key not configured" };
    const baseURL = process.env.ANTHROPIC_BASE_URL
      ? `${process.env.ANTHROPIC_BASE_URL}/v1`
      : undefined;
    return createAnthropic({ apiKey: config.apiKey, baseURL });
  },
  google: (config) => {
    if (!config?.apiKey) return { error: "google API key not configured" };
    return createGoogleGenerativeAI({ apiKey: config.apiKey });
  },
  "google-vertex": (config) => {
    if (!config?.projectId) return { error: "Vertex AI project not configured" };
    return createVertex({ project: config.projectId, location: config.location || "global" });
  },
};

interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  providerOptions?: ProviderOptions;
}

function getProviderOptions(db: Db, provider: string, modelId: string): ProviderOptions | undefined {
  // Vertex serves the same Gemini models; it reads provider options under the `vertex`
  // namespace rather than `google`.
  if ((provider === "google" || provider === "google-vertex") && CONFIG.thinkingModels.has(modelId)) {
    const budget = readAppSetting<number>(db, SETTINGS_KEYS.thinkingBudgetGoogle) ?? DEFAULTS.thinkingBudgetGoogle;
    const thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
    return provider === "google-vertex" ? { vertex: { thinkingConfig } } : { google: { thinkingConfig } };
  }
  if (provider === "anthropic") {
    const budget = readAppSetting<number>(db, SETTINGS_KEYS.thinkingBudgetAnthropic) ?? DEFAULTS.thinkingBudgetAnthropic;
    // A zero budget means thinking off — "enabled with 0 tokens" is rejected by the API.
    if (budget <= 0) return undefined;
    return { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } };
  }
  return undefined;
}

/** The single model setting: chat, provider agents, and utility agents all resolve here. */
export function resolveModel(db: Db): ResolvedModel | { error: string } {
  const config = readAppSetting<ModelConfig>(db, SETTINGS_KEYS.chatModel) ?? CONFIG.defaultChatModel;
  const factory = LLM_FACTORIES[config.provider];
  if (!factory) return { error: `Unknown LLM provider: ${config.provider}` };
  const builder = factory(readProviderConfig(db, config.provider));
  if (typeof builder !== "function") return builder;
  return { model: builder(config.modelId), modelId: config.modelId, providerOptions: getProviderOptions(db, config.provider, config.modelId) };
}

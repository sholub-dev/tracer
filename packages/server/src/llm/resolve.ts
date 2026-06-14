import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import type { LanguageModel, streamText } from "ai";
import { readProviderConfig, readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/client.js";
import { CONFIG, DEFAULTS, SETTINGS_KEYS, subAgentModelKey, type ModelConfig } from "../config.js";

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

export interface ResolvedModel {
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
    return { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } };
  }
  return undefined;
}

function resolveFromConfig(db: Db, config: ModelConfig): ResolvedModel | { error: string } {
  const factory = LLM_FACTORIES[config.provider];
  if (!factory) return { error: `Unknown LLM provider: ${config.provider}` };
  const builder = factory(readProviderConfig(db, config.provider));
  if (typeof builder !== "function") return builder;
  return { model: builder(config.modelId), modelId: config.modelId, providerOptions: getProviderOptions(db, config.provider, config.modelId) };
}

export function resolveModel(db: Db, settingsKey = SETTINGS_KEYS.chatModel): ResolvedModel | { error: string } {
  const config = readAppSetting<ModelConfig>(db, settingsKey) ?? CONFIG.defaultChatModel;
  return resolveFromConfig(db, config);
}

export function resolveUtilityModel(db: Db): ResolvedModel | { error: string } {
  return resolveFromConfig(db, CONFIG.defaultUtilityModel);
}

export function resolveSubAgentModel(db: Db, providerType: string): ResolvedModel | { error: string } {
  const config = readAppSetting<ModelConfig>(db, subAgentModelKey(providerType)) ?? CONFIG.defaultSubAgentModel;
  return resolveFromConfig(db, config);
}

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel, streamText } from "ai";
import { readProviderConfig, readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/client.js";

export type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

const LLM_FACTORIES: Record<string, (apiKey: string) => (modelId: string) => LanguageModel> = {
  anthropic: (key) => {
    const baseURL = process.env.ANTHROPIC_BASE_URL
      ? `${process.env.ANTHROPIC_BASE_URL}/v1`
      : undefined;
    return createAnthropic({ apiKey: key, baseURL });
  },
  google: (key) => createGoogleGenerativeAI({ apiKey: key }),
};

export interface ModelConfig {
  provider: string;
  modelId: string;
}

export const DEFAULT_CHAT_MODEL: ModelConfig = { provider: "google", modelId: "gemini-3.1-pro-preview" };
export const DEFAULT_SUB_AGENT_MODEL: ModelConfig = { provider: "google", modelId: "gemini-3-flash-preview" };
export const DEFAULT_UTILITY_MODEL: ModelConfig = { provider: "google", modelId: "gemini-3.1-flash-lite-preview" };

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  providerOptions?: ProviderOptions;
}

/** Models that support thinking/reasoning — excluded models (e.g. lite) get no thinking config. */
const THINKING_MODELS = new Set(["gemini-3.1-pro-preview", "gemini-3-flash-preview"]);

function getProviderOptions(provider: string, modelId: string): ProviderOptions | undefined {
  if (provider === "google" && THINKING_MODELS.has(modelId)) {
    return { google: { thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } } };
  }
  if (provider === "anthropic") {
    return { anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } } };
  }
  return undefined;
}

function resolveFromConfig(db: Db, config: ModelConfig): ResolvedModel | { error: string } {
  const factory = LLM_FACTORIES[config.provider];
  if (!factory) return { error: `Unknown LLM provider: ${config.provider}` };
  const apiKey = readProviderConfig(db, config.provider)?.apiKey;
  if (!apiKey) return { error: `${config.provider} API key not configured` };
  return { model: factory(apiKey)(config.modelId), modelId: config.modelId, providerOptions: getProviderOptions(config.provider, config.modelId) };
}

export function resolveModel(db: Db, settingsKey = "chat_model"): ResolvedModel | { error: string } {
  const config = readAppSetting<ModelConfig>(db, settingsKey) ?? DEFAULT_CHAT_MODEL;
  return resolveFromConfig(db, config);
}

export function resolveUtilityModel(db: Db): ResolvedModel | { error: string } {
  return resolveFromConfig(db, DEFAULT_UTILITY_MODEL);
}

export function resolveSubAgentModel(db: Db, providerType: string): ResolvedModel | { error: string } {
  const config = readAppSetting<ModelConfig>(db, `sub_agent_model:${providerType}`) ?? DEFAULT_SUB_AGENT_MODEL;
  return resolveFromConfig(db, config);
}

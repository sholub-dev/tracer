import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel, streamText } from "ai";
import { readProviderConfig, readAppSetting } from "../db/config-reader.js";
import type { Db } from "../db/driver.js";
import { CONFIG, DEFAULTS, ENV, SETTINGS_KEYS, type ModelConfig } from "../config.js";

export type { ModelConfig };
export type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

type ModelBuilder = (modelId: string) => LanguageModel;

let llmFetch: typeof fetch | undefined;

/** Sends LLM API calls through `fetch` instead of the global one. The iOS app passes the WebView fetch, which streams. */
export function setLlmFetch(fetchImpl: typeof fetch): void {
  llmFetch = fetchImpl;
}

/**
 * Each factory receives the provider's stored config record and returns a model
 * builder, or an error if required credentials are missing. API-key providers read
 * `apiKey`; Vertex reads `projectId`/`location` and authenticates via gcloud ADC.
 */
const LLM_FACTORIES: Record<string, (config: Record<string, string> | null) => ModelBuilder | { error: string } | Promise<ModelBuilder | { error: string }>> = {
  anthropic: (config) => {
    if (!config?.apiKey) return { error: "anthropic API key not configured" };
    const baseURL = ENV.ANTHROPIC_BASE_URL
      ? `${ENV.ANTHROPIC_BASE_URL}/v1`
      : undefined;
    // Anthropic rejects calls from a browser context without this header.
    const headers = llmFetch ? { "anthropic-dangerous-direct-browser-access": "true" } : undefined;
    return createAnthropic({ apiKey: config.apiKey, baseURL, fetch: llmFetch, headers });
  },
  google: (config) => {
    if (!config?.apiKey) return { error: "google API key not configured" };
    return createGoogle({ apiKey: config.apiKey, fetch: llmFetch });
  },
  // Loaded on demand: it pulls in google-auth-library, which needs Node.
  "google-vertex": async (config) => {
    if (!config?.projectId) return { error: "Vertex AI project not configured" };
    const { createVertex } = await import("@ai-sdk/google-vertex");
    return createVertex({ project: config.projectId, location: config.location || "global" });
  },
};

interface ResolvedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
  providerOptions?: ProviderOptions;
}

async function getProviderOptions(db: Db, provider: string, modelId: string): Promise<ProviderOptions | undefined> {
  // Vertex serves the same Gemini models; it reads provider options under the `vertex`
  // namespace rather than `google`.
  if ((provider === "google" || provider === "google-vertex") && CONFIG.thinkingModels.has(modelId)) {
    const budget = await readAppSetting<number>(db, SETTINGS_KEYS.thinkingBudgetGoogle) ?? DEFAULTS.thinkingBudgetGoogle;
    const thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
    return provider === "google-vertex" ? { vertex: { thinkingConfig } } : { google: { thinkingConfig } };
  }
  if (provider === "anthropic") {
    const budget = await readAppSetting<number>(db, SETTINGS_KEYS.thinkingBudgetAnthropic) ?? DEFAULTS.thinkingBudgetAnthropic;
    // A zero budget means thinking off — "enabled with 0 tokens" is rejected by the API.
    if (budget <= 0) return undefined;
    return { anthropic: { thinking: { type: "enabled", budgetTokens: budget } } };
  }
  return undefined;
}

/** The single model setting: chat, provider agents, and utility agents all resolve here. */
export async function resolveModel(db: Db): Promise<ResolvedModel | { error: string }> {
  const config = await readAppSetting<ModelConfig>(db, SETTINGS_KEYS.chatModel) ?? CONFIG.defaultChatModel;
  const factory = LLM_FACTORIES[config.provider];
  if (!factory) return { error: `Unknown LLM provider: ${config.provider}` };
  const builder = await factory(await readProviderConfig(db, config.provider));
  if (typeof builder !== "function") return builder;
  return { model: builder(config.modelId), provider: config.provider, modelId: config.modelId, providerOptions: await getProviderOptions(db, config.provider, config.modelId) };
}

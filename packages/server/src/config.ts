/**
 * Centralized server configuration.
 * Every tunable constant lives here — no magic numbers in the codebase.
 *
 * User-controllable settings (timezone, step limits, thinking budgets)
 * are stored in the `app_settings` DB table. The defaults below are
 * fallbacks when no DB value is set. Env vars override everything.
 */

import type { KnownModelId } from "@tracer-sh/shared";

export interface ModelConfig {
  provider: string;
  modelId: KnownModelId;
}

// ── Developer-only constants (not user-controllable) ──

export const CONFIG = {
  /** HTTP server port. Override with TRACER_PORT env var. */
  port: Number(process.env.TRACER_PORT) || 3579,

  /** CORS origin. null = derive from port at runtime as http://localhost:{port}. */
  corsOrigin: process.env.TRACER_CORS_ORIGIN ?? null as string | null,

  // ── LLM defaults ──

  defaultChatModel: { provider: "google", modelId: "gemini-3.1-pro-preview" } as ModelConfig,
  defaultSubAgentModel: { provider: "google", modelId: "gemini-3-flash-preview" } as ModelConfig,
  defaultUtilityModel: { provider: "google", modelId: "gemini-3.1-flash-lite-preview" } as ModelConfig,

  /** Models that support thinking/reasoning tokens. */
  thinkingModels: new Set(["gemini-3.1-pro-preview", "gemini-3-flash-preview"]),

  // ── MCP timeouts ──

  mcpInitTimeoutMs: 30_000,
  mcpReconnectCooldownMs: 60_000,
  mcpPingTimeoutMs: 5_000,

  // ── Agent result sizing ──

  maxModelResultChars: 8_000,

  // ── Monitor scheduler ──

  monitorTickIntervalMs: 10_000,
  monitorQueryTimeoutMs: 30_000,
  monitorMinFrequencySeconds: 30,

  // ── Server lifecycle ──

  shutdownGracePeriodMs: 5_000,
  restartExitCode: 75,

  // ── Updater ──

  npmViewTimeoutMs: 10_000,

  // ── Dashboard defaults ──

  widgetDefaultWidth: 6,
  widgetDefaultHeight: 6,
  gridColumns: 12,
} as const;

// ── User-controllable defaults (fallback when no DB value set) ──

export const DEFAULTS = {
  timezone: "America/Los_Angeles",
  directModeMaxSteps: 100,
  subAgentMaxSteps: 50,
  thinkingBudgetGoogle: 1024,
  thinkingBudgetAnthropic: 10_000,
} as const;

/** App settings keys stored in the `app_settings` table. */
export const SETTINGS_KEYS = {
  chatModel: "chat_model",
  chatMode: "chat_mode",
  timezone: "timezone",
  directModeMaxSteps: "direct_mode_max_steps",
  subAgentMaxSteps: "sub_agent_max_steps",
  thinkingBudgetGoogle: "thinking_budget_google",
  thinkingBudgetAnthropic: "thinking_budget_anthropic",
} as const;

/** Build the per-provider sub-agent model settings key. */
export function subAgentModelKey(providerType: string): string {
  return `sub_agent_model:${providerType}`;
}

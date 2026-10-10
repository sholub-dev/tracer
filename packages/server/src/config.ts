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

/** Environment variables; empty where no `process` exists (the iOS app). */
export const ENV: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env;

// ── Developer-only constants (not user-controllable) ──

export const CONFIG = {
  /** HTTP server port. Override with TRACER_PORT env var. */
  port: Number(ENV.TRACER_PORT) || 3579,

  /** HTTP server bind address. Loopback by default; set TRACER_HOST=0.0.0.0 to expose externally. */
  host: ENV.TRACER_HOST || "127.0.0.1",

  /** Bearer token every /api request must carry. Required when the server binds to a non-loopback address. */
  token: ENV.TRACER_TOKEN || null as string | null,

  /** Cap on one /api request body; fits several inline image attachments. */
  maxRequestBodyBytes: 64 * 1024 * 1024,

  /** CORS origin. null = derive from port at runtime as http://localhost:{port}. */
  corsOrigin: ENV.TRACER_CORS_ORIGIN ?? null as string | null,

  /** Interval of the keep-alive event on the live session stream, so clients detect a dead connection. */
  sseHeartbeatMs: 15_000,

  // ── LLM defaults ──

  /** Single model default — chat, provider agents, and utility agents (titles, memory). */
  defaultChatModel: { provider: "google", modelId: "gemini-3.7-flash" } as ModelConfig,

  /** Models that support thinking/reasoning tokens. */
  thinkingModels: new Set<string>(["gemini-3.7-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3-flash-preview"] satisfies KnownModelId[]),

  // ── MCP timeouts ──

  mcpInitTimeoutMs: 30_000,
  mcpReconnectCooldownMs: 60_000,
  mcpPingTimeoutMs: 5_000,

  /** Upper limit on one title or memory LLM call. */
  utilityCallTimeoutMs: 5 * 60_000,

  /** Per data source, the most notes and characters of memory a chat prompt carries. */
  memoryMaxNotes: 40,
  memoryMaxChars: 4000,

  /** Upper limit on one conclusion review call; a slow review must not hold the run. */
  reviewTimeoutMs: 90_000,

  /** Cap on the run transcript sent to the conclusion reviewer. */
  reviewTranscriptMaxChars: 60_000,

  /**
   * Code-level cap on the reasoning ("thinking") text a model may stream within a
   * single step. Enforced in the stream loops (not just via the provider
   * thinkingBudget, which models sometimes ignore and loop indefinitely) — when a
   * step exceeds this, the stream is aborted programmatically. Reset each step.
   */
  maxReasoningCharsPerStep: 40_000,

  /** Waits before re-running a background agent run (monitor, timer, API) that failed with an LLM/API error. */
  agentRetryDelaysMs: [5_000, 15_000, 45_000],
  /** Shorter waits for a chat the user watches. */
  chatRetryDelaysMs: [2_000, 8_000],
  /** Longest gap since a run's last save for which a restart still resumes it; an older run ends as done. */
  chatResumeMaxAgeSec: 10 * 60,
  /** Waits before repeating a data source or integration request that failed with a network error, 429 or 5xx. */
  fetchRetryDelaysMs: [1_000, 3_000],
  /** Least time between reconnect attempts for a data source that is not connected. */
  providerReconnectCooldownMs: 30_000,
  /** Upper limit on how long a chat start or a monitor check waits for reconnect pings. A slower ping goes on in the background. */
  providerReconnectWaitMs: 5_000,

  /** Upper limit on how long a status read waits for the startup connection checks (a status check makes one request of at most 35 s). */
  providerLoadWaitMs: 40_000,

  // ── Monitor scheduler ──

  monitorTickIntervalMs: 10_000,
  monitorQueryTimeoutMs: 30_000,
  monitorMinFrequencySeconds: 30,
  /** Window end trails now by this much so late-arriving events are counted. */
  monitorIngestLagSeconds: 60,
  /** Shorter lag for monitors on NrAiIncident: New Relic writes its own alert events within seconds. */
  monitorIncidentLagSeconds: 15,
  /** The iOS app's check on open skips a monitor checked within this many seconds of the new window's end. */
  monitorOpenSkipSeconds: 60,
  monitorRepeatWindowSeconds: 86_400,
  triageWatchMaxSeconds: 86_400,
  triageLoopWindowSeconds: 86_400,
  /** Closed, nr_closed and left_open issue rows are deleted after this long. */
  triageRetentionSeconds: 7 * 86_400,
  /** Monitor firings with no session left and sync delete markers are deleted after this long. */
  dataRetentionSeconds: 90 * 86_400,
  /** Least time between two retention sweeps. */
  retentionSweepIntervalMs: 60 * 60_000,
  /** Most monitor checks that run at once. */
  monitorMaxConcurrentChecks: 3,

  // ── Session follow-up timers ──

  timerMinMinutes: 1,
  timerMaxMinutes: 60,
  timerFollowUpMinutes: 5,
  /** A timer may not fire later than this after its session was created. */
  timerMaxAfterSessionSeconds: 86_400,
  timerMaxWakeupsPerTick: 3,
  timerBusyRetrySeconds: 60,

  // ── Server lifecycle ──

  shutdownGracePeriodMs: 5_000,
  restartExitCode: 75,

  // ── Updater ──

  npmViewTimeoutMs: 10_000,
  /** `npm install -g` can take a while (network + native rebuilds), so allow more headroom. */
  npmInstallTimeoutMs: 120_000,
  /** Buffer cap for `npm install -g` output; well above the 1MB default so a noisy
   *  but successful install (native rebuild logs) isn't misreported as a failure. */
  npmInstallMaxBufferBytes: 16 * 1024 * 1024,
  /** Transient download truncation (e.g. "Content-Length header ... exceeds response Body")
   *  is not retried inside npm, so the whole install is retried instead. */
  npmInstallAttempts: 3,
  npmInstallRetryDelayMs: 3_000,
  /** How often the server re-checks npm for a new version. */
  updateCheckIntervalMs: 60 * 60 * 1000,

  // ── Dashboard defaults ──

  widgetDefaultWidth: 6,
  widgetDefaultHeight: 6,
  gridColumns: 12,

  /** MCP subprocesses close after this long without a tool call, and restart on the next ping. */
  mcpIdleCloseMs: 15 * 60_000,
  /** Most sessions the session list returns, newest first. */
  sessionListLimit: 200,
} as const;

// ── User-controllable defaults (fallback when no DB value set) ──

export const DEFAULTS = {
  timezone: "America/Los_Angeles",
  directModeMaxSteps: 100,
  thinkingBudgetGoogle: 1024,
  thinkingBudgetAnthropic: 10_000,
} as const;

/** App settings keys stored in the `app_settings` table. */
export const SETTINGS_KEYS = {
  chatModel: "chat_model",
  timezone: "timezone",
  directModeMaxSteps: "direct_mode_max_steps",
  thinkingBudgetGoogle: "thinking_budget_google",
  thinkingBudgetAnthropic: "thinking_budget_anthropic",
  alertTriage: "alert_triage",
} as const;

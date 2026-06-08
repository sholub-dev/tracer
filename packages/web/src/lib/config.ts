/**
 * Centralized web configuration.
 * Every tunable UI constant lives here — no magic numbers in components.
 */

export const WEB_CONFIG = {
  // ── Polling intervals ──

  sessionStaleTimeMs: 30_000,
  activeStreamPollingMs: 5_000,
  monitorPollingMs: 60_000,
  updateCheckStaleTimeMs: 5 * 60 * 1000,
  // ── Self-update restart: poll for the restarted server, then reload ──
  /** Grace period before probing, to let the old server exit first. */
  updateRestartProbeDelayMs: 1_500,
  /** Interval between readiness probes while the server restarts. */
  updateRestartPollMs: 1_000,
  /** Give up polling and reload anyway after this long. */
  updateRestartMaxWaitMs: 60_000,

  // ── Layout ──

  sidebarWidth: 208,
  panelMinWidth: 260,
  panelMaxWidthRatio: 0.8,

  // ── Dashboard grid ──

  gridRows: 12,
  gridCols: 12,
  gridMinRowHeight: 20,
  gridMargin: [8, 8] as [number, number],

  // ── Chat ──

  chatThrottleMs: 50,

  // ── SSE ──

  maxSseErrors: 3,

  // ── Monitor chart ──

  maxBuckets: 366,
} as const;

/** Tunable UI constants, kept here instead of as magic numbers in components. */
export const WEB_CONFIG = {
  /** Also the global react-query staleTime default (main.tsx). */
  sessionStaleTimeMs: 30_000,
  /** Coalesces bursts of live session change events into one refetch. */
  sessionEventCoalesceMs: 100,
  subscriptionRetryMaxMs: 10_000,
  monitorPollingMs: 60_000,
  updateCheckStaleTimeMs: 5 * 60 * 1000,
  gcpProjectsStaleTimeMs: 5 * 60 * 1000,
  /** Grace period before probing a self-updating server, so the old one exits first. */
  updateRestartProbeDelayMs: 1_500,
  updateRestartPollMs: 1_000,
  /** Reload anyway after this long without an answer from the restarted server. */
  updateRestartMaxWaitMs: 60_000,

  /** Matches the sidebar's --sidebar-width. */
  sidebarWidth: 280,
  panelMinWidth: 260,
  panelMaxWidthRatio: 0.8,

  gridRows: 12,
  gridCols: 12,
  gridMinRowHeight: 20,
  gridMargin: [8, 8] as [number, number],

  /** Streaming re-render cadence; 100ms reads as live while halving render work vs 50ms. */
  chatThrottleMs: 100,
  maxSseErrors: 3,
  /** Upper bound on monitor chart buckets. */
  maxBuckets: 366,
} as const;

/**
 * Feature flags for gating disabled/in-progress features.
 * Toggle a flag to true to re-enable a feature.
 */

export const FEATURES = {
  /** Two-agent orchestrator mode (disabled — direct mode only). */
  orchestratorMode: false,

  /** Dashboard page with grid widgets. */
  dashboards: false,

  /** Monitor page with alerting. */
  monitors: false,
} as const;

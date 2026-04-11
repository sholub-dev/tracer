/**
 * Centralised step-limit constants for all agent modes.
 * Change these to adjust how many tool calls agents can make.
 */

/** Direct-mode chat (user ↔ model with tools). */
export const DIRECT_MODE_MAX_STEPS = 100;

/** Sub-agent spawned by the orchestrator for a single task. */
export const SUB_AGENT_MAX_STEPS = 50;

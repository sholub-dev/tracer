/**
 * PostHog prompt assembly — combines generic builders with PostHog domain knowledge.
 */

import {
  buildDirectModePrompt,
  buildUnifiedModeFragment,
  type ProviderPromptConfig,
} from "../../lib/prompt-builder.js";
import {
  POSTHOG_AUTH_STOP_RULE,
  POSTHOG_DOMAIN_KNOWLEDGE,
  POSTHOG_INSIDE_OUT_DEBUGGING,
} from "./domain-knowledge.js";

import { DEFAULTS } from "../../config.js";

export const POSTHOG_DIRECT_MODE_MAX_STEPS = DEFAULTS.directModeMaxSteps;

export const POSTHOG_CONFIG: ProviderPromptConfig = {
  providerName: "PostHog",
  authStopRule: POSTHOG_AUTH_STOP_RULE,
  domainKnowledge: POSTHOG_DOMAIN_KNOWLEDGE,
  insideOutDebugging: POSTHOG_INSIDE_OUT_DEBUGGING,
  directModeRoleIntro: `You are a PostHog expert having a direct conversation with a developer. You have full conversation history and can reference previous messages. Handle both simple lookups and multi-step investigations depending on what the user asks. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing.`,
  directModeMaxSteps: DEFAULTS.directModeMaxSteps,
};

export const directModeSystemPrompt = buildDirectModePrompt(POSTHOG_CONFIG);

/** Role-less PostHog block for the unified (one-agent, many-providers) prompt. */
export const posthogUnifiedFragment = buildUnifiedModeFragment(POSTHOG_CONFIG);

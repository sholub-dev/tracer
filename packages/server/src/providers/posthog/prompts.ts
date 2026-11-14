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

const POSTHOG_CONFIG: ProviderPromptConfig = {
  providerName: "PostHog",
  authStopRule: POSTHOG_AUTH_STOP_RULE,
  domainKnowledge: POSTHOG_DOMAIN_KNOWLEDGE,
  insideOutDebugging: POSTHOG_INSIDE_OUT_DEBUGGING,
  directModeRoleIntro: `You are a PostHog expert having a direct conversation with a developer. You have full conversation history and can reference previous messages. Handle both simple lookups and multi-step investigations depending on what the user asks. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you receive the results and keep calling tools until the causal chain reaches its end. The user can send a message while you work; it appears between your steps. Read it, then change course, answer it, or keep going.`,
};

export const directModeSystemPrompt = buildDirectModePrompt(POSTHOG_CONFIG);

/** Role-less PostHog block for the unified (one-agent, many-providers) prompt. */
export const posthogUnifiedFragment = buildUnifiedModeFragment(POSTHOG_CONFIG);

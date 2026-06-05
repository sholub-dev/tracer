/**
 * New Relic prompt assembly — combines generic builders with NR domain knowledge.
 */

import {
  buildDirectModePrompt,
  buildUnifiedModeFragment,
  type ProviderPromptConfig,
} from "../../lib/prompt-builder.js";
import {
  NR_AUTH_STOP_RULE,
  NR_DOMAIN_KNOWLEDGE,
  NR_INSIDE_OUT_DEBUGGING,
} from "./domain-knowledge.js";

import { DEFAULTS } from "../../config.js";

export const NR_DIRECT_MODE_MAX_STEPS = DEFAULTS.directModeMaxSteps;

export const NR_CONFIG: ProviderPromptConfig = {
  providerName: "New Relic",
  authStopRule: NR_AUTH_STOP_RULE,
  domainKnowledge: NR_DOMAIN_KNOWLEDGE,
  insideOutDebugging: NR_INSIDE_OUT_DEBUGGING,
  directModeRoleIntro: `You are a New Relic expert having a direct conversation with a developer. You have full conversation history and can reference previous messages. Handle both simple lookups and multi-step investigations depending on what the user asks. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing.`,
  directModeMaxSteps: DEFAULTS.directModeMaxSteps,
};

export const directModeSystemPrompt = buildDirectModePrompt(NR_CONFIG);

/** Role-less New Relic block for the unified (one-agent, many-providers) prompt. */
export const nrUnifiedFragment = buildUnifiedModeFragment(NR_CONFIG);

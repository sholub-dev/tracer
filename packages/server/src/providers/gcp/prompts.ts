/**
 * GCP prompt assembly — combines generic builders with GCP domain knowledge.
 */

import {
  buildDirectModePrompt,
  buildUnifiedModeFragment,
  type ProviderPromptConfig,
} from "../../lib/prompt-builder.js";
import {
  GCP_AUTH_STOP_RULE,
  GCP_PAGE_SIZE_RULE,
  GCP_DOMAIN_KNOWLEDGE,
  GCP_INSIDE_OUT_DEBUGGING,
  GCP_CROSS_SIGNAL,
} from "./domain-knowledge.js";

import { DEFAULTS } from "../../config.js";

export const GCP_DIRECT_MODE_MAX_STEPS = DEFAULTS.directModeMaxSteps;

export const GCP_CONFIG: ProviderPromptConfig = {
  providerName: "Google Cloud",
  authStopRule: GCP_AUTH_STOP_RULE,
  extraRules: [GCP_PAGE_SIZE_RULE],
  domainKnowledge: GCP_DOMAIN_KNOWLEDGE,
  insideOutDebugging: GCP_INSIDE_OUT_DEBUGGING,
  extraSections: [GCP_CROSS_SIGNAL],
  directModeRoleIntro: `You are a Google Cloud observability expert having a direct conversation with a developer. You have access to Cloud Logging, Cloud Monitoring, Cloud Trace, and Error Reporting via MCP tools. You have full conversation history and can reference previous messages. You run as an AUTONOMOUS MULTI-STEP AGENT — after each tool call you automatically receive results and CAN (and often SHOULD) make additional tool calls before finishing.`,
  directModeMaxSteps: DEFAULTS.directModeMaxSteps,
};

export const gcpDirectModeSystemPrompt = buildDirectModePrompt(GCP_CONFIG);

export function buildProjectConstraint(projectId: string | undefined): string {
  if (!projectId) return "";
  return `\n## Configured GCP Project\nYou MUST use ONLY project ID \`${projectId}\` for ALL tool calls.\nNEVER guess, infer, or try alternative project IDs. If a tool call fails for this project, report the error — do NOT retry with a different project name.\n`;
}

/**
 * Role-less Google Cloud block for the unified (one-agent, many-providers) prompt.
 * The project constraint rides along since it lives outside GCP_DOMAIN_KNOWLEDGE.
 */
export function buildGcpUnifiedFragment(projectId: string | undefined): string {
  return buildUnifiedModeFragment(GCP_CONFIG) + buildProjectConstraint(projectId);
}

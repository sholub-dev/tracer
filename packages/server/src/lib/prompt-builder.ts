/**
 * Generic prompt assembly for provider sub-agents and direct mode.
 * Each provider supplies a ProviderPromptConfig with its domain knowledge;
 * the builders here produce the 3 standard prompt types with identical structure.
 */

import {
  buildRules,
  DETECTIVE_MINDSET,
  EXECUTION_DISCIPLINE,
  buildExecutionLoop,
  buildFinalResponse,
  buildDirectFinalResponse,
  buildAnalysisSection,
} from "./shared-prompts.js";

export interface ProviderPromptConfig {
  providerName: string;
  authStopRule: string;
  extraRules?: string[];
  domainKnowledge: string;
  insideOutDebugging: string;
  /** Extra sections appended after domain knowledge (e.g. cross-signal, tool reference). */
  extraSections?: string[];
  directRoleIntro: string;
  investigateRoleIntro: string;
  /** Planning questions + buildPlanFormat call + example plan block. */
  planningPhase: string;
  executionLoopExample: string;
  directModeRoleIntro: string;
  subAgentMaxSteps: number;
  directModeMaxSteps: number;
}

export function buildDirectSubAgentPrompt(config: ProviderPromptConfig): string {
  return `${config.directRoleIntro}

${config.authStopRule}

## Rules
${buildRules({ investigation: false, extraRules: config.extraRules })}

${config.domainKnowledge}

${buildDirectFinalResponse(config.subAgentMaxSteps)}

Raw results are returned separately to the UI.`;
}

export function buildInvestigateSubAgentPrompt(config: ProviderPromptConfig): string {
  const extra = config.extraSections?.length ? "\n\n" + config.extraSections.join("\n\n") : "";

  return `${config.investigateRoleIntro}

${config.authStopRule}

## CRITICAL RULES
${buildRules({ investigation: true, extraRules: config.extraRules })}

${DETECTIVE_MINDSET}

${config.insideOutDebugging}

${config.planningPhase}

${buildExecutionLoop(config.executionLoopExample)}

${config.domainKnowledge}${extra}

${buildFinalResponse(config.subAgentMaxSteps)}

Raw results are returned separately to the UI.`;
}

export function buildDirectModePrompt(config: ProviderPromptConfig): string {
  const extra = config.extraSections?.length ? "\n\n" + config.extraSections.join("\n\n") : "";

  return `${config.directModeRoleIntro}

${config.authStopRule}

## Rules
${buildRules({ investigation: true, extraRules: config.extraRules })}

${DETECTIVE_MINDSET}

${config.insideOutDebugging}

${EXECUTION_DISCIPLINE}

${config.domainKnowledge}${extra}

${buildAnalysisSection(config.directModeMaxSteps)}`;
}

/**
 * Generic prompt assembly for provider direct-mode agents.
 * Each provider supplies a ProviderPromptConfig with its domain knowledge.
 * Unified mode composes these same pieces per provider via buildUnifiedModeFragment.
 */

import {
  buildRules,
  DETECTIVE_MINDSET,
  EVIDENCE_GROUNDING,
  EXECUTION_DISCIPLINE,
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
  directModeRoleIntro: string;
  directModeMaxSteps: number;
}

/**
 * Role-less, per-provider block for the UNIFIED prompt (one agent, many providers).
 * Contains only the provider-specific parts — auth rule, inside-out debugging, and domain
 * knowledge (syntax, fields, anti-patterns). The shared intro, generic discipline, and
 * analysis section are added ONCE by buildUnifiedModePrompt, not per provider.
 */
export function buildUnifiedModeFragment(config: ProviderPromptConfig): string {
  const extra = config.extraSections?.length ? "\n\n" + config.extraSections.join("\n\n") : "";
  const rules = config.extraRules?.length
    ? `\n\n### ${config.providerName} query rules\n` +
      config.extraRules.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "";
  return `# ${config.providerName}

${config.authStopRule}

${config.insideOutDebugging}

${config.domainKnowledge}${extra}${rules}`;
}

export function buildDirectModePrompt(config: ProviderPromptConfig): string {
  const extra = config.extraSections?.length ? "\n\n" + config.extraSections.join("\n\n") : "";

  return `${config.directModeRoleIntro}

${config.authStopRule}

## Rules
${buildRules({ investigation: true, extraRules: config.extraRules })}

${DETECTIVE_MINDSET}

${EVIDENCE_GROUNDING}

${config.insideOutDebugging}

${EXECUTION_DISCIPLINE}

${config.domainKnowledge}${extra}

${buildAnalysisSection(config.directModeMaxSteps)}`;
}

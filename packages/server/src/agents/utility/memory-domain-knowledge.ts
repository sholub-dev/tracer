import { NR_DOMAIN_KNOWLEDGE } from "../../providers/newrelic/domain-knowledge.js";
import { GCP_DOMAIN_KNOWLEDGE } from "../../providers/gcp/domain-knowledge.js";
import { POSTHOG_DOMAIN_KNOWLEDGE } from "../../providers/posthog/domain-knowledge.js";

/**
 * Maps provider types to their domain knowledge for memory agents.
 * Memory agents need this context to judge whether a lesson is genuinely
 * novel vs already covered by system prompt knowledge.
 */
const DOMAIN_KNOWLEDGE: Record<string, string> = {
  newrelic: NR_DOMAIN_KNOWLEDGE,
  gcp: GCP_DOMAIN_KNOWLEDGE,
  posthog: POSTHOG_DOMAIN_KNOWLEDGE,
};

export function getDomainKnowledge(providerType: string): string | undefined {
  return DOMAIN_KNOWLEDGE[providerType];
}

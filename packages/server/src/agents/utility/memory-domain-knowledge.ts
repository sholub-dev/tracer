/**
 * Maps provider types to their domain knowledge for memory agents.
 * Memory agents need this context to judge whether a lesson is genuinely
 * novel vs already covered by system prompt knowledge.
 *
 * Uses lazy imports so domain knowledge strings are only loaded
 * when actually needed for a specific provider type.
 */

type DomainLoader = () => Promise<string>;

const DOMAIN_LOADERS: Record<string, DomainLoader> = {
  newrelic: async () =>
    (await import("../../providers/newrelic/domain-knowledge.js"))
      .NR_DOMAIN_KNOWLEDGE,
  gcp: async () =>
    (await import("../../providers/gcp/domain-knowledge.js"))
      .GCP_DOMAIN_KNOWLEDGE,
};

export async function getDomainKnowledge(
  providerType: string,
): Promise<string | undefined> {
  const loader = DOMAIN_LOADERS[providerType];
  if (!loader) return undefined;
  return loader();
}

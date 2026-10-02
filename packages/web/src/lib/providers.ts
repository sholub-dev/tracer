const PROVIDERS: Record<string, { label: string; dot: string; order: number }> = {
  newrelic: { label: "New Relic", dot: "bg-new-relic", order: 0 },
  posthog: { label: "PostHog", dot: "bg-posthog", order: 1 },
  gcp: { label: "Google Cloud", dot: "bg-gcp", order: 2 },
  jira: { label: "Jira", dot: "bg-jira", order: 3 },
};

export const providerLabel = (type: string, fallback?: string) => PROVIDERS[type]?.label ?? fallback ?? type;

/** The one place provider colors are chosen; the colors themselves are tokens in index.css. */
export const providerColorClass = (type: string) => PROVIDERS[type]?.dot ?? "bg-muted-foreground";

export function sortProviders<T extends { type: string }>(providers: T[]): T[] {
  return [...providers].sort((a, b) => (PROVIDERS[a.type]?.order ?? 99) - (PROVIDERS[b.type]?.order ?? 99));
}

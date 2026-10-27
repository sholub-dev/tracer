/** PostHog provider configuration */
export interface PosthogProviderConfig {
  type: "posthog";
  /** Personal API key (scoped to Query Read). */
  apiKey: string;
  /** Numeric project id. */
  projectId: string;
  /** API host. Defaults to https://us.posthog.com when empty. */
  host?: string;
}

/**
 * Response shape of the PostHog Query API (`POST /api/projects/:id/query/`)
 * when run with a HogQLQuery. Rows are arrays aligned to `columns`.
 */
export interface HogQLQueryResponse {
  results: unknown[][];
  columns: string[];
  types?: string[];
  /** Some error conditions are returned in the body rather than via a non-2xx status. */
  error?: string;
  hogql?: string;
}

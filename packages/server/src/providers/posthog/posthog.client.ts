import type { HogQLQueryResponse } from "./types.js";

const DEFAULT_HOST = "https://us.posthog.com";

/**
 * Thin client over PostHog's official Query API. Runs HogQL (PostHog's SQL)
 * via `POST {host}/api/projects/{projectId}/query/`, authenticated with a
 * personal API key. Mirrors NerdGraphClient — plain fetch, no SDK.
 */
export class PosthogClient {
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly host: string;

  constructor(apiKey: string, projectId: string, host?: string) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.host = (host?.trim() || DEFAULT_HOST).replace(/\/+$/, "");
  }

  async query(hogql: string): Promise<HogQLQueryResponse> {
    const response = await fetch(`${this.host}/api/projects/${this.projectId}/query/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query: hogql },
        name: "tracer",
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (!response.ok) {
      // PostHog returns a JSON error body; surface its `detail`/`error` so auth
      // failures produce a clear, actionable message (feeds the auth-stop rule).
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { detail?: string; error?: string };
        detail = body.detail ?? body.error ?? detail;
      } catch {
        /* non-JSON body — keep the status line */
      }
      throw new Error(`PostHog query failed: ${detail}`);
    }

    const result = (await response.json()) as HogQLQueryResponse;

    if (result.error) {
      throw new Error(`PostHog query error: ${result.error}`);
    }

    return result;
  }
}

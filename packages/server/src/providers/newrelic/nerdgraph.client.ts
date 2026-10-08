import { fetchWithRetry } from "../../lib/fetch-retry.js";
import type { NerdGraphResponse } from "./types.js";

export interface AiIssue {
  issueId: string;
  state: "CREATED" | "ACTIVATED" | "DEACTIVATED" | "CLOSED";
  title: string[] | null;
  incidentIds: string[] | null;
  conditionName: string[] | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

export interface AiIssuesFilter {
  ids?: string[];
  policyIds?: number[];
  conditionIds?: number[];
}

const AI_ISSUES_MAX_PAGES = 10;

export class NerdGraphClient {
  private readonly apiKey: string;
  private readonly accountId: string;

  constructor(apiKey: string, accountId: string) {
    this.apiKey = apiKey;
    this.accountId = accountId;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>, optIn?: string, retry?: boolean): Promise<T> {
    const response = await fetchWithRetry("https://api.newrelic.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": this.apiKey,
        ...(optIn ? { "nerd-graph-unsafe-experimental-opt-in": optIn } : {}),
      },
      body: JSON.stringify({ query, variables: { accountId: parseInt(this.accountId, 10), ...variables } }),
    }, { timeoutMs: 35_000, retry });

    if (!response.ok) {
      throw new Error(`NerdGraph request failed: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as { errors?: { message: string }[] };

    if (result.errors?.length) {
      throw new Error(`NerdGraph error: ${result.errors[0].message}`);
    }

    return result as T;
  }

  async query(nrql: string, options?: { retry?: boolean }): Promise<NerdGraphResponse> {
    return this.graphql<NerdGraphResponse>(`query($accountId: Int!, $nrql: Nrql!) {
      actor {
        account(id: $accountId) {
          nrql(query: $nrql, timeout: 30) {
            results
          }
        }
      }
    }`, { nrql }, undefined, options?.retry);
  }

  async aiIssues(filter: AiIssuesFilter, startMs: number, endMs: number): Promise<AiIssue[]> {
    return (await this.aiIssuesPage(filter, startMs, endMs)).issues;
  }

  /** `truncated` is true when the page cap stopped the read before the last issue. */
  async aiIssuesPage(filter: AiIssuesFilter, startMs: number, endMs: number): Promise<{ issues: AiIssue[]; truncated: boolean }> {
    const query = `query($accountId: Int!, $filter: AiIssuesFilterIssues, $tw: TimeWindowInput, $cursor: String) {
      actor {
        account(id: $accountId) {
          aiIssues {
            issues(filter: $filter, timeWindow: $tw, cursor: $cursor) {
              nextCursor
              issues { issueId state title incidentIds conditionName acknowledgedAt acknowledgedBy }
            }
          }
        }
      }
    }`;
    type Page = { data?: { actor: { account: { aiIssues: { issues: { nextCursor: string | null; issues: AiIssue[] | null } } } } } };
    const issues: AiIssue[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < AI_ISSUES_MAX_PAGES; page++) {
      const res: Page = await this.graphql<Page>(query, { filter, tw: { startTime: startMs, endTime: endMs }, cursor }, "AiIssues");
      const result = res.data?.actor.account.aiIssues.issues;
      issues.push(...(result?.issues ?? []));
      cursor = result?.nextCursor ?? null;
      if (!cursor) break;
    }
    if (cursor) console.warn(`[newrelic] aiIssues stopped after ${AI_ISSUES_MAX_PAGES} pages; later issues were not read`);
    return { issues, truncated: cursor !== null };
  }

  ackIssue(issueId: string): Promise<{ ok: true } | { error: string }> {
    return this.issueAction("aiIssuesAckIssue", issueId);
  }

  resolveIssue(issueId: string): Promise<{ ok: true } | { error: string }> {
    return this.issueAction("aiIssuesResolveIssue", issueId);
  }

  /** Never throws. */
  private async issueAction(mutation: "aiIssuesAckIssue" | "aiIssuesResolveIssue", issueId: string): Promise<{ ok: true } | { error: string }> {
    try {
      const res = await this.graphql<{ data?: Record<string, { error: string | null; result: { issueId: string } | null } | null> }>(
        `mutation($accountId: Int!, $issueId: ID!) {
          ${mutation}(accountId: $accountId, issueId: $issueId) { error result { issueId } }
        }`,
        { issueId },
        "AiIssues",
      );
      const out = res.data?.[mutation];
      if (out?.error) return { error: out.error };
      return out?.result ? { ok: true } : { error: "No result from New Relic" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

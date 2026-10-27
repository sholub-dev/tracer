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
  priority: string | null;
  entityNames: string[] | null;
  createdAt: number | null;
  activatedAt: number | null;
  closedAt: number | null;
}

export interface AiIssuesFilter {
  ids?: string[];
  states?: AiIssue["state"][];
  policyIds?: number[];
  conditionIds?: number[];
}

const AI_ISSUES_MAX_PAGES = 10;
const NRQL_TIMEOUT_S = 60;
const NRQL_FETCH_TIMEOUT_MS = 65_000;
const NRQL_TIMEOUT_MESSAGE = "The query timed out: narrow the window, add a WHERE clause or aggregate";

export class NerdGraphClient {
  private readonly apiKey: string;
  private readonly accountId: string;

  constructor(apiKey: string, accountId: string) {
    this.apiKey = apiKey;
    this.accountId = accountId;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>, optIn?: string, retry?: boolean, timeoutMs = 35_000): Promise<T> {
    const response = await fetchWithRetry("https://api.newrelic.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": this.apiKey,
        ...(optIn ? { "nerd-graph-unsafe-experimental-opt-in": optIn } : {}),
      },
      body: JSON.stringify({ query, variables: { accountId: parseInt(this.accountId, 10), ...variables } }),
    }, { timeoutMs, retry });

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`NerdGraph request failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
    }

    const result = (await response.json()) as { errors?: { message: string }[] };

    if (result.errors?.length) {
      throw new Error(`NerdGraph error: ${result.errors.map((e) => e.message).join("; ")}`);
    }

    return result as T;
  }

  async query(nrql: string, options?: { retry?: boolean }): Promise<NerdGraphResponse> {
    let res: NerdGraphResponse;
    try {
      res = await this.graphql<NerdGraphResponse>(`query($accountId: Int!, $nrql: Nrql!) {
        actor {
          account(id: $accountId) {
            nrql(query: $nrql, timeout: ${NRQL_TIMEOUT_S}) {
              results
              metadata { timeWindow { begin end } messages }
            }
          }
        }
      }`, { nrql }, undefined, options?.retry, NRQL_FETCH_TIMEOUT_MS);
    } catch (err) {
      // Quoted parts echo the query, so an attribute or a value such as 'timeout' or '504' is not a timeout.
      const message = (err instanceof Error ? err.message : String(err)).replace(/'[^']*'/g, "");
      throw /\btime(d)?[ -]?out\b|\b504\b/i.test(message) ? new Error(NRQL_TIMEOUT_MESSAGE) : err;
    }
    if (!res.data?.actor.account.nrql) throw new Error("New Relic returned no result for this query");
    return res;
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
              issues { issueId state title incidentIds conditionName acknowledgedAt acknowledgedBy priority entityNames createdAt activatedAt closedAt }
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

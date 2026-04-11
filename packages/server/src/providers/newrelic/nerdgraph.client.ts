import type { NerdGraphResponse } from "./types.js";

export class NerdGraphClient {
  private readonly apiKey: string;
  private readonly accountId: string;

  constructor(apiKey: string, accountId: string) {
    this.apiKey = apiKey;
    this.accountId = accountId;
  }

  async query(nrql: string): Promise<NerdGraphResponse> {
    const graphqlQuery = `query($accountId: Int!, $nrql: Nrql!) {
      actor {
        account(id: $accountId) {
          nrql(query: $nrql, timeout: 30) {
            results
          }
        }
      }
    }`;

    const response = await fetch("https://api.newrelic.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": this.apiKey,
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { accountId: parseInt(this.accountId, 10), nrql },
      }),
      signal: AbortSignal.timeout(35_000),
    });

    if (!response.ok) {
      throw new Error(`NerdGraph request failed: ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as NerdGraphResponse;

    if (result.errors?.length) {
      throw new Error(`NerdGraph error: ${result.errors[0].message}`);
    }

    return result;
  }
}

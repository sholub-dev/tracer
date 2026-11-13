/** NerdGraph API response wrapper */
export interface NerdGraphResponse {
  data?: {
    actor: {
      account: {
        nrql: NrqlQueryResult;
      };
    };
  };
}

/** NRQL query result */
export interface NrqlQueryResult {
  results: NrqlResult[];
  metadata?: {
    timeWindow?: { begin: number; end: number } | null;
    messages?: string[] | null;
  } | null;
}

/** Single NRQL result row */
export interface NrqlResult {
  [key: string]: unknown;
}

/** New Relic provider configuration */
export interface NewRelicProviderConfig {
  type: "newrelic";
  apiKey: string;
  accountId: string;
}

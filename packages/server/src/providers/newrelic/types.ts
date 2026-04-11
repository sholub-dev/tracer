/** NerdGraph API response wrapper */
export interface NerdGraphResponse<T = NrqlQueryResult> {
  data?: {
    actor: {
      account: {
        nrql: T;
      };
    };
  };
  errors?: NerdGraphError[];
}

/** NerdGraph error */
export interface NerdGraphError {
  message: string;
  extensions?: {
    errorClass?: string;
    code?: string;
  };
}

/** NRQL query result */
export interface NrqlQueryResult {
  results: NrqlResult[];
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

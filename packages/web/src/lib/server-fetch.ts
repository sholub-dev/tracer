let impl: typeof fetch = (input, init) => fetch(input, init);

/** Fetch for calls to the Tracer server. The iOS app answers them in-process. */
export const serverFetch: typeof fetch = (input, init) => impl(input, init);

export function setServerFetch(fetchImpl: typeof fetch): void {
  impl = fetchImpl;
}

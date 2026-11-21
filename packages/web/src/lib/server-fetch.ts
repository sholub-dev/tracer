import { acceptToken, getSessionToken, refuseToken } from "./session-token";

let impl: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const token = getSessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(input, { ...init, headers });
  if (res.ok) acceptToken(token);
  // A Request object is not sent again: its body is spent.
  else if (res.status === 401 && refuseToken(token) && !(input instanceof Request)) return impl(input, init);
  return res;
};

/** Fetch for calls to the Tracer server, with the session secret. The iOS app answers them in-process, with no secret. */
export const serverFetch: typeof fetch = (input, init) => impl(input, init);

export function setServerFetch(fetchImpl: typeof fetch): void {
  impl = fetchImpl;
}

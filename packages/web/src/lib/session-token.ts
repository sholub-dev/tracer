const STORAGE_KEY = "tracer-session-token";

let token: string | null = null;
// The stored secret, while a different one from a link waits for its first accepted call.
let previous: string | null = null;
let locked = false;
const listeners = new Set<() => void>();

export function tokenFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("t") || null;
}

function store(value: string): void {
  try { localStorage.setItem(STORAGE_KEY, value); } catch { /* storage off: the secret lasts until the page closes */ }
}

/**
 * Takes the server's secret from the link fragment (`#t=...`) or from storage. The fragment never leaves the browser,
 * and it is removed from the address bar so a copied address or a screenshot does not carry the secret.
 * A secret from a link replaces a stored one only after the server accepts it, so a link with a wrong secret
 * does not lock the app.
 */
export function startSession(): void {
  const fromHash = tokenFromHash(window.location.hash);
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage off */ }
  token = fromHash ?? stored;
  previous = fromHash && fromHash !== stored ? stored : null;
  if (fromHash) {
    if (!previous) store(fromHash);
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  locked = !token;
  // A link pasted into the open tab changes only the fragment, which does not reload the page.
  window.addEventListener("hashchange", () => { if (tokenFromHash(window.location.hash)) window.location.reload(); });
}

export const getSessionToken = (): string | null => token;

export const isLocked = (): boolean => locked;

/** The server accepted a call that carried `used`. */
export function acceptToken(used: string | null): void {
  if (!previous || !used || used !== token) return;
  previous = null;
  store(used);
}

/**
 * The server refused `used`. Returns true when the caller must repeat the call: the stored secret took over from
 * a refused link secret, or it did so while this call was on its way.
 */
export function refuseToken(used: string | null): boolean {
  if (used !== token) return true;
  if (!previous) {
    lockSession();
    return false;
  }
  token = previous;
  previous = null;
  return true;
}

/** The server refused the stored secret. */
export function lockSession(): void {
  if (locked) return;
  locked = true;
  listeners.forEach((notify) => notify());
}

export function subscribeLocked(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

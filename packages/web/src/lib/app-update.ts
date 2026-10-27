import { isNewerVersion } from "@tracer-sh/shared";

export function shouldCheckForAppUpdate(lastCheckAt: number | null, now: number, minIntervalMs: number): boolean {
  return lastCheckAt === null || now - lastCheckAt >= minIntervalMs;
}

/** A dismissed version stays hidden; a newer release is offered again. */
export function shouldOfferAppUpdate(installed: string, latest: string, dismissed: string | null): boolean {
  return isNewerVersion(latest, installed) && latest !== dismissed;
}

/** The latest release of the npm package, which is kept equal to the TestFlight build version. Null when offline. */
export async function fetchLatestAppVersion(): Promise<string | null> {
  try {
    // Not AbortSignal.timeout: it needs iOS 16.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    const res = await fetch("https://registry.npmjs.org/tracer-sh/latest", { signal: abort.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    const { version } = (await res.json()) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

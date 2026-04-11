import { readFileSync } from "node:fs";
import { join } from "node:path";

export type GcpAuthResult =
  | { ok: true; token: string }
  | { ok: false; code: "no_credentials" | "reauth_required" | "auth_failed"; message: string };

const REAUTH_CMD = "Run: gcloud auth application-default login";

// Google access tokens are valid for 3600s; cache for 55 min to stay safely under that.
const TOKEN_TTL_MS = 55 * 60 * 1000;
let tokenCache: { token: string; expiresAt: number } | null = null;

/** Clear the cached access token — call this after user re-authenticates. */
export function clearGcpAuthCache(): void {
  tokenCache = null;
}

/**
 * Read ADC from the standard gcloud location and exchange the refresh token for an access token.
 * Caches the token for 55 minutes; returns a structured result to distinguish failure reasons.
 */
export async function getGcpAuth(): Promise<GcpAuthResult> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return { ok: true, token: tokenCache.token };
  }

  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(process.env.HOME ?? "", ".config", "gcloud", "application_default_credentials.json");

  let creds: { client_id?: string; client_secret?: string; refresh_token?: string; type?: string };
  try {
    creds = JSON.parse(readFileSync(credPath, "utf-8"));
  } catch {
    return { ok: false, code: "no_credentials", message: `No GCP credentials found. ${REAUTH_CMD}` };
  }

  if (creds.type !== "authorized_user" || !creds.refresh_token) {
    return { ok: false, code: "no_credentials", message: `No GCP credentials found. ${REAUTH_CMD}` };
  }

  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.client_id ?? "",
        client_secret: creds.client_secret ?? "",
        refresh_token: creds.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      code: "auth_failed",
      message: `GCP token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    let errorCode = "";
    let errorSubtype = "";
    try {
      const body = (await res.json()) as { error?: string; error_subtype?: string };
      errorCode = body.error ?? "";
      errorSubtype = body.error_subtype ?? "";
    } catch { /* ignore parse errors */ }

    if (errorCode === "invalid_grant" && errorSubtype === "invalid_rapt") {
      return {
        ok: false,
        code: "reauth_required",
        message: `GCP authentication requires re-login (RAPT challenge). ${REAUTH_CMD}`,
      };
    }
    if (errorCode === "invalid_grant") {
      return {
        ok: false,
        code: "auth_failed",
        message: `GCP credentials are invalid or expired. ${REAUTH_CMD}`,
      };
    }
    return {
      ok: false,
      code: "auth_failed",
      message: `GCP token exchange failed (${res.status}). ${REAUTH_CMD}`,
    };
  }

  const token = (await res.json()) as { access_token?: string };
  if (!token.access_token) {
    return {
      ok: false,
      code: "auth_failed",
      message: `GCP token exchange returned no access token. ${REAUTH_CMD}`,
    };
  }

  tokenCache = { token: token.access_token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return { ok: true, token: token.access_token };
}

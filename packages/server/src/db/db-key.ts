import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Loaded lazily (only when no env key is set) so the keychain native module is
// never required on platforms that supply TRACER_DB_KEY directly. Named to avoid
// colliding with the `require` shim tsup injects into the bundle banner.
const requireCjs = createRequire(import.meta.url);

const SERVICE = "tracer-sh";
const ACCOUNT = "db-key";

function isValidKeyHex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function generateKeyHex(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Resolve the 64-hex DB encryption key with a layered, never-bricks strategy:
 *   1. TRACER_DB_KEY env var (explicit; for CI / headless / no-keychain hosts).
 *   2. OS keychain (user-scoped, machine-bound) — generated and stored on first run.
 *   3. A key file next to the data, with a warning, when the keychain is
 *      unavailable (e.g. a headless Linux box with no Secret Service).
 */
export function resolveDbKey(tracerHome: string): string {
  const envKey = process.env.TRACER_DB_KEY?.trim();
  if (envKey) {
    if (!isValidKeyHex(envKey)) {
      throw new Error("TRACER_DB_KEY must be 64 hex characters (a 32-byte key).");
    }
    return envKey.toLowerCase();
  }

  return tryKeychain() ?? resolveKeyFile(tracerHome);
}

function tryKeychain(): string | null {
  try {
    const { Entry } = requireCjs("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    const entry = new Entry(SERVICE, ACCOUNT);

    let existing: string | null = null;
    try {
      existing = entry.getPassword();
    } catch {
      existing = null; // not found
    }
    if (existing && isValidKeyHex(existing)) return existing.toLowerCase();

    const fresh = generateKeyHex();
    entry.setPassword(fresh);
    return fresh;
  } catch {
    // Keychain backend missing/unavailable — fall through to the file fallback.
    return null;
  }
}

function resolveKeyFile(tracerHome: string): string {
  const keyPath = join(tracerHome, "db-key");
  if (existsSync(keyPath)) {
    const fromFile = readFileSync(keyPath, "utf8").trim();
    if (isValidKeyHex(fromFile)) {
      warnKeyFile(keyPath);
      return fromFile.toLowerCase();
    }
  }
  const fresh = generateKeyHex();
  writeFileSync(keyPath, fresh, { mode: 0o600 });
  warnKeyFile(keyPath);
  return fresh;
}

function warnKeyFile(keyPath: string): void {
  console.warn(
    `[tracer] OS keychain unavailable — storing the database encryption key in a file at ${keyPath}. ` +
      `It is created owner-only (0600) on macOS/Linux; on Windows it relies on the data directory's ACLs. ` +
      `Anyone who can read this file can read the database — set TRACER_DB_KEY to supply the key yourself instead.`,
  );
}

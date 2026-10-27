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

type KeychainEntry = { getPassword(): string | null; setPassword(password: string): void };

function loadKeychain(): KeychainEntry | null {
  try {
    const { Entry } = requireCjs("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    // Linux otherwise falls back to in-memory keyutils, which loses the key on reboot.
    return new Entry(SERVICE, ACCOUNT, { linux: { store: "secret-service" } });
  } catch {
    return null;
  }
}

// Env key, then keychain, then key file. A keychain read error is never treated as "no key".
export function resolveDbKey(
  tracerHome: string,
  { hasEncryptedDb = false, keychain }: { hasEncryptedDb?: boolean; keychain?: KeychainEntry | null } = {},
): string {
  const envKey = process.env.TRACER_DB_KEY?.trim();
  if (envKey) {
    if (!isValidKeyHex(envKey)) {
      throw new Error("TRACER_DB_KEY must be 64 hex characters (a 32-byte key).");
    }
    return envKey.toLowerCase();
  }

  const keyPath = join(tracerHome, "db-key");
  const entry = keychain === undefined ? loadKeychain() : keychain;
  if (!entry) return readKeyFile(keyPath) ?? createKeyFile(keyPath, hasEncryptedDb);

  let existing: string | null;
  try {
    existing = entry.getPassword();
  } catch (err) {
    const fileKey = readKeyFile(keyPath);
    if (fileKey) return fileKey;
    // No keychain service (e.g. headless Linux) and no data yet: a key file is safe.
    if (!hasEncryptedDb) return createKeyFile(keyPath, false);
    throw new Error(
      `Could not read the database encryption key from the OS keychain (${err instanceof Error ? err.message : String(err)}). ` +
        `Unlock the keychain and restart, or set TRACER_DB_KEY.`,
    );
  }
  if (existing && isValidKeyHex(existing)) return existing.toLowerCase();
  const fileKey = readKeyFile(keyPath);
  if (fileKey) return fileKey;
  if (hasEncryptedDb) throw missingKeyError();

  const fresh = generateKeyHex();
  try {
    entry.setPassword(fresh);
    return fresh;
  } catch {
    return createKeyFile(keyPath, hasEncryptedDb);
  }
}

function missingKeyError(): Error {
  return new Error(
    "The database is encrypted but its key was not found in the OS keychain, a key file, or TRACER_DB_KEY. " +
      "Refusing to generate a new key, which would make the existing database unreadable.",
  );
}

function readKeyFile(keyPath: string): string | null {
  if (!existsSync(keyPath)) return null;
  const fromFile = readFileSync(keyPath, "utf8").trim();
  if (!isValidKeyHex(fromFile)) return null;
  warnKeyFile(keyPath);
  return fromFile.toLowerCase();
}

function createKeyFile(keyPath: string, hasEncryptedDb: boolean): string {
  if (hasEncryptedDb) throw missingKeyError();
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

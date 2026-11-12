import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// Loaded lazily, only for the one-time move out of the keychain. Named to avoid
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

type KeychainEntry = { getPassword(): string | null; deletePassword?(): boolean };

export type ResolvedDbKey = { key: string; finishMigration?: () => void };

function loadKeychain(): KeychainEntry | null {
  try {
    const { Entry } = requireCjs("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
    // Linux otherwise falls back to in-memory keyutils, which loses the key on reboot.
    return new Entry(SERVICE, ACCOUNT, { linux: { store: "secret-service" } });
  } catch {
    return null;
  }
}

// Env key, then the owner-only key file. An existing encrypted DB with no key file
// moves its key once from the OS keychain into the file. The keychain entry is
// deleted by finishMigration, only after the DB has opened with the key.
export function resolveDbKey(
  tracerHome: string,
  { hasEncryptedDb = false, keychain }: { hasEncryptedDb?: boolean; keychain?: KeychainEntry | null } = {},
): ResolvedDbKey {
  const envKey = process.env.TRACER_DB_KEY?.trim();
  if (envKey) {
    if (!isValidKeyHex(envKey)) {
      throw new Error("TRACER_DB_KEY must be 64 hex characters (a 32-byte key).");
    }
    return { key: envKey.toLowerCase() };
  }

  const keyPath = join(tracerHome, "db-key");
  const fileKey = readKeyFile(keyPath);
  if (fileKey) return { key: fileKey };

  if (!hasEncryptedDb) {
    const fresh = generateKeyHex();
    writeKeyFile(keyPath, fresh);
    console.warn(`[tracer] Created the database key file ${keyPath} (owner-only). If you lose it, you lose the database.`);
    return { key: fresh };
  }

  const entry = keychain === undefined ? loadKeychain() : keychain;
  console.warn(
    `[tracer] Moving the database key from the OS keychain to ${keyPath}. If the system asks, choose Allow (not Always Allow).`,
  );
  let stored: string | null = null;
  let readError = "the keychain is not available";
  if (entry) {
    try {
      stored = entry.getPassword();
      readError = "no key entry was found";
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!stored || !isValidKeyHex(stored)) {
    throw new Error(
      `Could not read the database key from the OS keychain (${readError}). Nothing was changed. ` +
        `Restart Tracer and allow the keychain request, or set TRACER_DB_KEY.`,
    );
  }
  const key = stored.toLowerCase();
  writeKeyFile(keyPath, key);
  return {
    key,
    finishMigration() {
      let removed = false;
      try {
        removed = entry?.deletePassword?.() === true;
      } catch {
        // The key file is now the source of truth; a stale entry is harmless.
      }
      console.warn(
        removed
          ? "[tracer] The database key now lives in the key file; the keychain entry was removed."
          : `[tracer] The database key now lives in the key file. Remove the old keychain entry "${SERVICE}" / "${ACCOUNT}" by hand.`,
      );
    },
  };
}

function readKeyFile(keyPath: string): string | null {
  if (!existsSync(keyPath)) return null;
  const fromFile = readFileSync(keyPath, "utf8").trim();
  return isValidKeyHex(fromFile) ? fromFile.toLowerCase() : null;
}

// Temp file + rename so a crash never leaves a partial key; "wx" refuses to follow a planted file.
function writeKeyFile(keyPath: string, key: string): void {
  const tmp = `${keyPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
    renameSync(tmp, keyPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw err;
  }
  if (readFileSync(keyPath, "utf8") !== key) throw new Error(`Could not verify the key file at ${keyPath}.`);
}

import { createRequire } from "node:module";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

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
    // No database depends on the file here, so one that holds no valid key is replaced.
    const key = writeKeyFile(keyPath, fresh, true);
    if (key === fresh) console.warn(`[tracer] Created the database key file ${keyPath} (owner-only). If you lose it, you lose the database.`);
    return { key };
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
  const key = writeKeyFile(keyPath, stored.toLowerCase());
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
  // Windows has no mode bits to check.
  if (process.platform !== "win32" && statSync(keyPath).mode & 0o077) {
    chmodSync(keyPath, 0o600);
    console.warn(`[tracer] The database key file ${keyPath} was readable by other users. It is now owner-only.`);
  }
  const fromFile = readFileSync(keyPath, "utf8").trim();
  return isValidKeyHex(fromFile) ? fromFile.toLowerCase() : null;
}

const NO_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

// Temp file + link so a crash never leaves a partial key; "wx" refuses to follow a planted file.
// A link, unlike a rename, fails when the key file exists: a process that starts at the same moment
// then uses the key of the first one. A file system without hard links gets a rename. Returns the key in the file.
function writeKeyFile(keyPath: string, key: string, replaceInvalid = false): string {
  const tmp = `${keyPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
    let exists = false;
    try {
      linkSync(tmp, keyPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code !== "EEXIST" && !NO_LINK_CODES.has(code)) throw err;
      exists = code === "EEXIST" || existsSync(keyPath);
      if (!exists) renameSync(tmp, keyPath);
    }
    if (exists) {
      const existing = readKeyFile(keyPath);
      if (existing) return existing;
      if (!replaceInvalid) throw new Error(`The key file ${keyPath} exists but does not hold a valid key. Nothing was changed.`);
      renameSync(tmp, keyPath);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
  }
  if (readFileSync(keyPath, "utf8") !== key) throw new Error(`Could not verify the key file at ${keyPath}.`);
  return key;
}

import { renameSync, rmSync, existsSync, copyFileSync, openSync, readSync, closeSync } from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3-multiple-ciphers";

/** The 16-byte magic every plaintext SQLite file starts with. SQLCipher encrypts
 *  the header, so an encrypted DB does not carry it. */
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Apply the SQLCipher key to a freshly opened connection. Must run before any
 * other statement. Used for both the live connection and migration verification
 * so the read path and write path always agree on cipher + key format.
 */
export function applyKey(conn: DatabaseType, keyHex: string): void {
  conn.pragma("cipher='sqlcipher'");
  conn.pragma(`key="x'${keyHex}'"`);
}

/**
 * True if the file exists and is an unencrypted SQLite DB — i.e. a pre-encryption
 * file that needs migrating. Detected by the header magic rather than by opening a
 * connection, so a missing file (fresh install), an encrypted file, or a locked/
 * corrupt file are never mistaken for "plaintext, safe to leave".
 */
export function isPlaintext(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, "r");
    const header = Buffer.alloc(16);
    const bytes = readSync(fd, header, 0, 16, 0);
    return bytes === 16 && header.toString("latin1") === SQLITE_MAGIC;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * One-time conversion of a plaintext SQLite DB to an encrypted one. Crash-safe:
 * it writes a verified encrypted copy to a temp file and only then atomically
 * swaps it in. On any failure the original plaintext DB is left untouched and the
 * temp is removed, so the next launch simply retries. No plaintext copy lingers.
 */
export function migratePlaintextToEncrypted(dbPath: string, keyHex: string): void {
  const tmpPath = `${dbPath}.enc.tmp`;
  cleanupTmp(tmpPath); // clear any leftovers from an interrupted attempt

  // Fold committed WAL pages back into the main file so the byte copy below is
  // complete (nothing stranded in -wal), then release the handle.
  const plain = new Database(dbPath);
  try {
    plain.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    plain.close();
  }

  // Encrypt a *copy*: rekey it in place, fold its own WAL back, then verify and
  // atomically swap it in. The original plaintext DB is untouched until the
  // rename, so an interrupted run leaves it intact and is safely retried.
  try {
    copyFileSync(dbPath, tmpPath);
    const enc = new Database(tmpPath);
    enc.pragma("cipher='sqlcipher'");
    enc.pragma(`rekey="x'${keyHex}'"`);
    enc.pragma("wal_checkpoint(TRUNCATE)");
    enc.close();
  } catch (err) {
    cleanupTmp(tmpPath);
    throw new Error(`Database encryption migration failed: ${(err as Error).message}`);
  }

  // Before destroying the plaintext original, prove the copy is genuinely
  // encrypted (no longer carries the SQLite header magic) AND structurally sound
  // (passes an integrity check once keyed).
  try {
    if (isPlaintext(tmpPath)) throw new Error("encrypted copy is still readable as plaintext");
    const verify = new Database(tmpPath);
    applyKey(verify, keyHex);
    const result = verify.pragma("integrity_check", { simple: true });
    verify.close();
    if (result !== "ok") throw new Error(`integrity check returned "${String(result)}"`);
  } catch (err) {
    cleanupTmp(tmpPath);
    throw new Error(`Database encryption verification failed: ${(err as Error).message}`);
  }

  // Drop the original's now-stale journal siblings BEFORE the swap so a crash
  // mid-rename can never leave a plaintext -wal next to the encrypted DB.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-journal`, { force: true });
  renameSync(tmpPath, dbPath);
  // Any journal siblings the verify open may have left under the temp name.
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

function cleanupTmp(tmpPath: string): void {
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });
}

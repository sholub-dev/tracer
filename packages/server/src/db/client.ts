import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { resolveDbKey } from "./db-key.js";
import { applyKey, isPlaintext, migratePlaintextToEncrypted } from "./db-encryption.js";

export const TRACER_HOME = process.env.TRACER_HOME || join(homedir(), ".tracer");
const dataDir = join(TRACER_HOME, "data");
mkdirSync(dataDir, { recursive: true });
chmodSync(TRACER_HOME, 0o700);
chmodSync(dataDir, 0o700);

const dbPath = join(dataDir, "tracer.db");
const keyHex = resolveDbKey(TRACER_HOME);

// Detection-driven, one-time migration: a plaintext DB left by a pre-encryption
// version is converted in place on the first boot of the encrypted build. Fresh
// installs have no file yet and are created encrypted below.
if (isPlaintext(dbPath)) {
  migratePlaintextToEncrypted(dbPath, keyHex);
}

export const sqlite: DatabaseType = new Database(dbPath);
applyKey(sqlite, keyHex); // must precede every other statement on this connection
sqlite.pragma("journal_mode = WAL");
// NORMAL skips the per-commit WAL fsync; with WAL a crash can lose the last
// commit but never corrupts the database.
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;

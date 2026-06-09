import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export const TRACER_HOME = process.env.TRACER_HOME || join(homedir(), ".tracer");
const dataDir = join(TRACER_HOME, "data");
mkdirSync(dataDir, { recursive: true });
chmodSync(TRACER_HOME, 0o700);
chmodSync(dataDir, 0o700);

export const sqlite: DatabaseType = new Database(join(dataDir, "tracer.db"));
sqlite.pragma("journal_mode = WAL");
// NORMAL skips the per-commit WAL fsync; with WAL a crash can lose the last
// commit but never corrupts the database.
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;

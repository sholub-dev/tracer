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
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;

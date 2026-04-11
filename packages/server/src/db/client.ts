import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export const OKO_HOME = process.env.OKO_HOME || join(homedir(), ".oko");
const dataDir = join(OKO_HOME, "data");
mkdirSync(dataDir, { recursive: true });

export const sqlite: DatabaseType = new Database(join(dataDir, "oko.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export type Db = typeof db;

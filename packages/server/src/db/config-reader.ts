import { eq, inArray } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Db } from "./client.js";
import { providerConfigs, appSettings } from "./schema.js";

export function readProviderConfig(db: Db, type: string): Record<string, string> | null {
  const row = db.select().from(providerConfigs).where(eq(providerConfigs.type, type)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.config) as Record<string, string>;
  } catch {
    console.warn(`[config] Corrupted provider config for "${type}"`);
    return null;
  }
}

export function readAppSetting<T>(db: Db, key: string): T | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    console.warn(`[config] Corrupted app setting "${key}"`);
    return null;
  }
}

/** Read multiple app settings in a single query. Returns a map of key → parsed value. */
export function readAppSettings(db: Db, keys: string[]): Record<string, unknown> {
  const rows = db.select().from(appSettings).where(inArray(appSettings.key, keys)).all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { /* skip corrupted */ }
  }
  return result;
}

/** Upsert a single app setting. */
export function writeAppSetting(db: Db, key: string, value: unknown): void {
  const json = JSON.stringify(value);
  const now = unixNow();
  db.insert(appSettings)
    .values({ key, value: json, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: json, updatedAt: now } })
    .run();
}

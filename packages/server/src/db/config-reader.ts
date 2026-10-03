import { eq, inArray } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Db } from "./driver.js";
import { providerConfigs, appSettings } from "./schema.js";

export async function readProviderConfig(db: Db, type: string): Promise<Record<string, string> | null> {
  const row = await db.select().from(providerConfigs).where(eq(providerConfigs.type, type)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.config) as Record<string, string>;
  } catch {
    console.warn(`[config] Corrupted provider config for "${type}"`);
    return null;
  }
}

export async function readAppSetting<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    console.warn(`[config] Corrupted app setting "${key}"`);
    return null;
  }
}

/** Read multiple app settings in a single query. Returns a map of key → parsed value. */
export async function readAppSettings(db: Db, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, keys)).all();
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch { /* skip corrupted */ }
  }
  return result;
}

/** Upsert a single app setting. */
export async function writeAppSetting(db: Db, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const now = unixNow();
  await db.insert(appSettings)
    .values({ key, value: json, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: json, updatedAt: now } })
    .run();
}

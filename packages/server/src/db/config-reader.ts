import { eq } from "drizzle-orm";
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

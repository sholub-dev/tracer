import { eq } from "drizzle-orm";
import type { Db } from "../../db/driver.js";
import { appSettings } from "../../db/schema.js";
import { readAppSetting, writeAppSetting } from "../../db/config-reader.js";
import type { JiraClientConfig } from "./jira.client.js";

export const JIRA_CONFIG_KEY = "integration:jira";

export function readJiraConfig(db: Db): Promise<JiraClientConfig | null> {
  return readAppSetting<JiraClientConfig>(db, JIRA_CONFIG_KEY);
}

export async function writeJiraConfig(db: Db, config: JiraClientConfig): Promise<void> {
  await writeAppSetting(db, JIRA_CONFIG_KEY, config);
}

export async function deleteJiraConfig(db: Db): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, JIRA_CONFIG_KEY)).run();
}

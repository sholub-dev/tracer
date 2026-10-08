import { eq } from "drizzle-orm";
import type { Db } from "../../db/driver.js";
import { appSettings } from "../../db/schema.js";
import { readAppSetting, writeAppSetting } from "../../db/config-reader.js";
import { isJiraDomain, type JiraClientConfig } from "./jira.client.js";

export const JIRA_CONFIG_KEY = "integration:jira";

export async function readJiraConfig(db: Db): Promise<JiraClientConfig | null> {
  const config = await readAppSetting<JiraClientConfig>(db, JIRA_CONFIG_KEY);
  return config && typeof config.domain === "string" && isJiraDomain(config.domain) ? config : null;
}

export async function writeJiraConfig(db: Db, config: JiraClientConfig): Promise<void> {
  await writeAppSetting(db, JIRA_CONFIG_KEY, config);
}

export async function deleteJiraConfig(db: Db): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, JIRA_CONFIG_KEY)).run();
}

import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appSettings } from "../../db/schema.js";
import { readAppSetting, writeAppSetting } from "../../db/config-reader.js";
import type { JiraClientConfig } from "./jira.client.js";

export const JIRA_CONFIG_KEY = "integration:jira";

export function readJiraConfig(db: Db): JiraClientConfig | null {
  return readAppSetting<JiraClientConfig>(db, JIRA_CONFIG_KEY);
}

export function writeJiraConfig(db: Db, config: JiraClientConfig): void {
  writeAppSetting(db, JIRA_CONFIG_KEY, config);
}

export function deleteJiraConfig(db: Db): void {
  db.delete(appSettings).where(eq(appSettings.key, JIRA_CONFIG_KEY)).run();
}

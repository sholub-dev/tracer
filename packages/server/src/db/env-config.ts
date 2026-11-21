import { ENV, SETTINGS_KEYS } from "../config.js";
import type { Db } from "./driver.js";
import { readAppSetting, readProviderConfig, writeAppSetting, writeProviderConfig } from "./config-reader.js";
import { isPosthogHost, isPosthogProjectId, normalizePosthogHost } from "../providers/posthog/posthog.client.js";
import { isJiraDomain } from "../integrations/jira/jira.client.js";
import { isSlackWebhook } from "../integrations/slack.js";

type Env = Record<string, string | undefined>;

interface Target {
  name: string;
  store: "provider" | "setting";
  key: string;
  /** Environment variable -> field of the stored object. */
  fields: Record<string, string>;
}

/** The same checks the settings routes apply. */
const VALID: Record<string, (value: string) => boolean> = {
  TRACER_POSTHOG_HOST: (host) => isPosthogHost(normalizePosthogHost(host)),
  TRACER_POSTHOG_PROJECT_ID: isPosthogProjectId,
  TRACER_JIRA_DOMAIN: isJiraDomain,
  TRACER_SLACK_WEBHOOK_URL: isSlackWebhook,
};

const TARGETS: Target[] = [
  { name: "anthropic", store: "provider", key: "anthropic", fields: { TRACER_ANTHROPIC_API_KEY: "apiKey" } },
  { name: "google", store: "provider", key: "google", fields: { TRACER_GOOGLE_API_KEY: "apiKey" } },
  { name: "newrelic", store: "provider", key: "newrelic", fields: { TRACER_NEW_RELIC_API_KEY: "apiKey", TRACER_NEW_RELIC_ACCOUNT_ID: "accountId" } },
  { name: "posthog", store: "provider", key: "posthog", fields: { TRACER_POSTHOG_API_KEY: "apiKey", TRACER_POSTHOG_PROJECT_ID: "projectId", TRACER_POSTHOG_HOST: "host" } },
  { name: "jira", store: "setting", key: "integration:jira", fields: { TRACER_JIRA_DOMAIN: "domain", TRACER_JIRA_EMAIL: "email", TRACER_JIRA_API_TOKEN: "apiToken" } },
  { name: "slack", store: "setting", key: "integration:slack", fields: { TRACER_SLACK_WEBHOOK_URL: "webhookUrl" } },
];

/** Moves connector keys from environment variables into the config tables, so a headless server needs no UI setup. */
export async function seedConfigFromEnv(db: Db, env: Env = ENV): Promise<string[]> {
  const seeded: string[] = [];

  for (const t of TARGETS) {
    const supplied: Record<string, string> = {};
    for (const [name, field] of Object.entries(t.fields)) {
      const value = env[name];
      // Child processes must not inherit the keys.
      delete env[name];
      if (!value) continue;
      if (VALID[name] && !VALID[name](value)) console.warn(`[config] ${name} is not valid; ignored`);
      else supplied[field] = value;
    }
    if (!Object.keys(supplied).length) continue;
    const stored = t.store === "provider"
      ? await readProviderConfig(db, t.key)
      : await readAppSetting<Record<string, string>>(db, t.key);
    if (Object.entries(supplied).every(([f, v]) => stored?.[f] === v)) continue;
    const merged = { ...stored, ...supplied };
    if (t.store === "provider") await writeProviderConfig(db, t.key, merged);
    else await writeAppSetting(db, t.key, merged);
    seeded.push(t.name);
  }

  const chatModel = env.TRACER_CHAT_MODEL;
  delete env.TRACER_CHAT_MODEL;
  if (chatModel) {
    const [provider, ...rest] = chatModel.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) {
      console.warn('[config] TRACER_CHAT_MODEL must look like "provider/modelId"; ignored');
    } else {
      // Only a first default: a model picked later in the UI must survive restarts.
      if (!(await readAppSetting(db, SETTINGS_KEYS.chatModel))) {
        await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider, modelId });
        seeded.push("chat model");
      }
    }
  }

  if (seeded.length) console.log(`Config from environment: ${seeded.join(", ")}`);
  return seeded;
}

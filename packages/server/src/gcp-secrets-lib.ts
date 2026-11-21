/** Reads Google Secret Manager values. No side effects on import: the preload and the fetch entry both import it. */

export interface SecretRef {
  envName: string;
  /** Project id from a full secret name, else null. */
  project: string | null;
  secret: string;
  version: string;
}

export class SecretsError extends Error {
  constructor(readonly failures: string[]) {
    super(failures.join("\n"));
  }
}

/** The database key and the variables the server moves into its config; it removes each of them from its environment. */
export const SECRET_NAMES = new Set([
  "TRACER_DB_KEY", "TRACER_CHAT_MODEL", "TRACER_GOOGLE_API_KEY", "TRACER_ANTHROPIC_API_KEY",
  "TRACER_NEW_RELIC_API_KEY", "TRACER_NEW_RELIC_ACCOUNT_ID",
  "TRACER_POSTHOG_API_KEY", "TRACER_POSTHOG_PROJECT_ID", "TRACER_POSTHOG_HOST",
  "TRACER_JIRA_DOMAIN", "TRACER_JIRA_EMAIL", "TRACER_JIRA_API_TOKEN", "TRACER_SLACK_WEBHOOK_URL",
]);
const SECRET_ID = /^[A-Za-z0-9_-]+$/;
const FULL_NAME = /^projects\/([A-Za-z0-9_.:-]+)\/secrets\/([A-Za-z0-9_-]+)$/;
const VERSION = /^(latest|\d+)$/;
const TIMEOUT_MS = 10_000;

export function parseSecretSpec(spec: string): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const envName = eq < 0 ? "" : entry.slice(0, eq).trim();
    const target = eq < 0 ? "" : entry.slice(eq + 1).trim();
    const colon = target.lastIndexOf(":");
    const name = colon < 0 ? target : target.slice(0, colon).trim();
    const version = colon < 0 ? "latest" : target.slice(colon + 1).trim();
    const full = FULL_NAME.exec(name);
    if (!envName || !(full || SECRET_ID.test(name)) || !VERSION.test(version)) {
      throw new Error(`TRACER_SECRETS: malformed entry "${entry}"; expected TRACER_NAME=SECRET or TRACER_NAME=SECRET:VERSION`);
    }
    if (!SECRET_NAMES.has(envName)) {
      throw new Error(`TRACER_SECRETS: "${envName}" is not an allowed name; allowed names: ${[...SECRET_NAMES].join(", ")}`);
    }
    refs.push({ envName, project: full ? full[1] : null, secret: full ? full[2] : name, version });
  }
  return refs;
}

export type Env = Record<string, string | undefined>;

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Loads each listed secret into `env`. Throws SecretsError, listing every failure, when any secret cannot load. */
export async function loadSecrets(spec: string, env: Env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const refs = parseSecretSpec(spec);
  if (!refs.length) return [];

  const host = env.GCE_METADATA_HOST || "metadata.google.internal";
  const meta = { "Metadata-Flavor": "Google" };
  const metadata = (path: string) => getJson(fetchImpl, `http://${host}/computeMetadata/v1/${path}`, meta);
  const label = (r: SecretRef) => `${r.envName} (secret ${r.secret})`;

  let token: string;
  let defaultProject: string | undefined = env.GOOGLE_CLOUD_PROJECT || undefined;
  try {
    token = (await metadata("instance/service-accounts/default/token")).access_token;
    if (!token) throw new Error("no access_token in response");
    if (!defaultProject && refs.some((r) => !r.project)) {
      // The project id endpoint returns plain text, not JSON.
      const res = await fetchImpl(`http://${host}/computeMetadata/v1/project/project-id`, { headers: meta, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} reading project id`);
      defaultProject = (await res.text()).trim();
    }
  } catch (err) {
    throw new SecretsError(refs.map((r) => `${label(r)}: metadata server: ${err instanceof Error ? err.message : String(err)}`));
  }

  const failures: string[] = [];
  const values = await Promise.all(refs.map(async (r) => {
    try {
      const project = r.project ?? defaultProject;
      const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${r.secret}/versions/${r.version}:access`;
      const body = await getJson(fetchImpl, url, { Authorization: `Bearer ${token}` });
      if (typeof body?.payload?.data !== "string") throw new Error("response has no payload");
      const value = Buffer.from(body.payload.data, "base64").toString("utf8").replace(/\r?\n$/, "");
      if (!value.trim()) throw new Error("secret is empty");
      return value;
    } catch (err) {
      failures.push(`${label(r)}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }));
  if (failures.length) throw new SecretsError(failures);

  refs.forEach((r, i) => { env[r.envName] = values[i]!; });
  return refs.map((r) => r.envName);
}

/** Puts the values of a `{ NAME: value }` JSON text into `env`. */
export function applySecretsJson(text: string, env: Env): string[] {
  const values: unknown = JSON.parse(text);
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("expected a JSON object");
  const entries = Object.entries(values);
  for (const [name, value] of entries) {
    if (!SECRET_NAMES.has(name) || typeof value !== "string" || !value.trim()) throw new Error(`bad value for ${name}`);
  }
  for (const [name, value] of entries) env[name] = value as string;
  return entries.map(([name]) => name);
}

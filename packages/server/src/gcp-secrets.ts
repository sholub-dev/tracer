/**
 * Preload: copies Google Secret Manager values into process.env before the server module loads.
 * Run as `node --import ./dist/gcp-secrets.js ./dist/index.js`. Self-contained on purpose.
 */

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

const ENV_NAME = /^TRACER_[A-Z0-9_]+$/;
// These decide where the server listens and stores data; a secret must not set them.
const RESERVED = new Set(["TRACER_HOST", "TRACER_HOME", "TRACER_TOKEN", "TRACER_SECRETS"]);
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
    if (!ENV_NAME.test(envName) || RESERVED.has(envName) || !(full || SECRET_ID.test(name)) || !VERSION.test(version)) {
      throw new Error(`TRACER_SECRETS: malformed entry "${entry}"; expected TRACER_NAME=SECRET or TRACER_NAME=SECRET:VERSION`);
    }
    refs.push({ envName, project: full ? full[1] : null, secret: full ? full[2] : name, version });
  }
  return refs;
}

type Env = Record<string, string | undefined>;

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
      if (!value) throw new Error("secret is empty");
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

const spec = process.env.TRACER_SECRETS?.trim();
if (spec) {
  try {
    const names = await loadSecrets(spec, process.env);
    // Without it the server would write a new key file next to the database.
    if (!process.env.TRACER_DB_KEY) throw new Error("TRACER_SECRETS must supply TRACER_DB_KEY");
    console.log(`Secrets loaded from Secret Manager: ${names.join(", ")}`);
  } catch (err) {
    const lines = err instanceof SecretsError ? err.failures : [err instanceof Error ? err.message : String(err)];
    for (const line of lines) console.error(`[gcp-secrets] ${line}`);
    process.exit(1);
  }
}

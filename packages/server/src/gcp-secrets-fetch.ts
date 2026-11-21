/**
 * Entry file: fetches the secrets of TRACER_SECRETS and prints them as a `{ NAME: value }` JSON text.
 * The preload `gcp-secrets.js` reads that text from stdin when TRACER_SECRETS_STDIN is set.
 */
import { loadSecrets, SecretsError, type Env } from "./gcp-secrets-lib.js";

try {
  // Not process.env: the values go to stdout only.
  const target: Env = { GCE_METADATA_HOST: process.env.GCE_METADATA_HOST, GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT };
  const names = await loadSecrets(process.env.TRACER_SECRETS?.trim() ?? "", target);
  // Without it the server would write a new key file next to the database.
  if (!target.TRACER_DB_KEY?.trim()) throw new Error("the secrets must include TRACER_DB_KEY");
  process.stdout.write(JSON.stringify(Object.fromEntries(names.map((n) => [n, target[n]]))));
} catch (err) {
  const lines = err instanceof SecretsError ? err.failures : [err instanceof Error ? err.message : String(err)];
  for (const line of lines) console.error(`[gcp-secrets] ${line}`);
  process.exit(1);
}

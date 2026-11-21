/**
 * Preload: puts Google Secret Manager values into process.env before the server module loads.
 * Run as `node --import ./dist/gcp-secrets.js ./dist/index.js`.
 * - TRACER_SECRETS set: fetches the listed secrets.
 * - TRACER_SECRETS_STDIN set: reads the values as JSON from stdin, for a server that cannot reach the metadata server.
 * `gcp-secrets-fetch.js` prints that JSON.
 */
import { readFileSync } from "node:fs";
import { applySecretsJson, loadSecrets, SecretsError } from "./gcp-secrets-lib.js";

export * from "./gcp-secrets-lib.js";

const spec = process.env.TRACER_SECRETS?.trim();
const fromStdin = !!process.env.TRACER_SECRETS_STDIN;
if (spec || fromStdin) {
  try {
    const names = fromStdin ? applySecretsJson(readFileSync(0, "utf8"), process.env) : await loadSecrets(spec ?? "", process.env);
    // Without it the server would write a new key file next to the database.
    if (!process.env.TRACER_DB_KEY?.trim()) throw new Error("the secrets must include TRACER_DB_KEY");
    console.log(`Secrets loaded: ${names.join(", ")}`);
    delete process.env.TRACER_SECRETS_STDIN;
  } catch (err) {
    const lines = err instanceof SecretsError ? err.failures : [err instanceof Error ? err.message : String(err)];
    for (const line of lines) console.error(`[gcp-secrets] ${line}`);
    process.exit(1);
  }
}

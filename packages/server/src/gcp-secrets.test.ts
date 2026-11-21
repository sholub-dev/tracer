import { test } from "node:test";
import assert from "node:assert/strict";
import { applySecretsJson, loadSecrets, parseSecretSpec, SECRET_NAMES, SecretsError } from "./gcp-secrets.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

/** Fake metadata and Secret Manager. `secrets` maps "project/secret/version" to a value; absent ones answer `missing`. */
function fakeFetch(secrets: Record<string, string>, missing = 404) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (url.endsWith("/service-accounts/default/token")) return Response.json({ access_token: "tok" });
    if (url.endsWith("/project/project-id")) return new Response("meta-proj\n");
    const m = /projects\/([^/]+)\/secrets\/([^/]+)\/versions\/([^:]+):access$/.exec(url);
    const value = m ? secrets[`${m[1]}/${m[2]}/${m[3]}`] : undefined;
    if (value === undefined) return new Response("nope", { status: missing });
    return Response.json({ payload: { data: b64(value) } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("parses short ids, full names, versions and whitespace", () => {
  assert.deepEqual(parseSecretSpec(" TRACER_ANTHROPIC_API_KEY = s1 , TRACER_GOOGLE_API_KEY=projects/p/secrets/s2:7,, TRACER_CHAT_MODEL=s3:latest "), [
    { envName: "TRACER_ANTHROPIC_API_KEY", project: null, secret: "s1", version: "latest" },
    { envName: "TRACER_GOOGLE_API_KEY", project: "p", secret: "s2", version: "7" },
    { envName: "TRACER_CHAT_MODEL", project: null, secret: "s3", version: "latest" },
  ]);
});

test("rejects malformed entries", () => {
  for (const bad of ["TRACER_JIRA_EMAIL", "TRACER_JIRA_EMAIL=", "=s", "TRACER_JIRA_EMAIL=bad id!", "TRACER_JIRA_EMAIL=s:v1", "TRACER_JIRA_EMAIL=projects/p/s", "NODE_OPTIONS=bad id!"]) {
    assert.throws(() => parseSecretSpec(bad), /malformed entry/, bad);
  }
});

test("rejects a name outside the allowed names and says so", () => {
  for (const name of ["NODE_OPTIONS", "PATH", "tracer_x", "TRACER_FOO", "TRACER_PORT", "TRACER_CORS_ORIGIN", "TRACER_HOST", "TRACER_HOME", "TRACER_TOKEN", "TRACER_SECRETS"]) {
    assert.throws(() => parseSecretSpec(`${name}=s`), new RegExp(`"${name}" is not an allowed name`), name);
  }
});

test("loads secrets into env and strips one trailing newline", async () => {
  const { impl, calls } = fakeFetch({ "p/a/latest": "one\n", "p/b/3": "two\r\n", "p/c/latest": "three\n\n" });
  const env: Record<string, string | undefined> = { GOOGLE_CLOUD_PROJECT: "p" };
  const names = await loadSecrets("TRACER_ANTHROPIC_API_KEY=a,TRACER_GOOGLE_API_KEY=b:3,TRACER_CHAT_MODEL=c", env, impl);
  assert.deepEqual(names, ["TRACER_ANTHROPIC_API_KEY", "TRACER_GOOGLE_API_KEY", "TRACER_CHAT_MODEL"]);
  assert.equal(env.TRACER_ANTHROPIC_API_KEY, "one");
  assert.equal(env.TRACER_GOOGLE_API_KEY, "two");
  assert.equal(env.TRACER_CHAT_MODEL, "three\n");
  const secretCall = calls.find((c) => c.url.includes("secretmanager"))!;
  assert.equal(secretCall.headers.Authorization, "Bearer tok");
  assert.equal(calls.find((c) => c.url.includes("/token"))!.headers["Metadata-Flavor"], "Google");
});

test("takes the project from the metadata server when GOOGLE_CLOUD_PROJECT is unset", async () => {
  const { impl, calls } = fakeFetch({ "meta-proj/a/latest": "v" });
  const env: Record<string, string | undefined> = { GCE_METADATA_HOST: "meta.test" };
  await loadSecrets("TRACER_ANTHROPIC_API_KEY=a", env, impl);
  assert.equal(env.TRACER_ANTHROPIC_API_KEY, "v");
  assert.ok(calls.some((c) => c.url === "http://meta.test/computeMetadata/v1/project/project-id"));
});

test("GOOGLE_CLOUD_PROJECT and full names skip the project lookup", async () => {
  const { impl, calls } = fakeFetch({ "other/a/latest": "v" });
  await loadSecrets("TRACER_ANTHROPIC_API_KEY=projects/other/secrets/a", {}, impl);
  assert.ok(!calls.some((c) => c.url.endsWith("/project/project-id")));
});

test("a 404 and a 403 fail closed, name each secret and leave env unset", async () => {
  const { impl } = fakeFetch({ "p/ok/latest": "SECRET-VALUE" }, 404);
  const env: Record<string, string | undefined> = { GOOGLE_CLOUD_PROJECT: "p" };
  await assert.rejects(loadSecrets("TRACER_POSTHOG_HOST=ok,TRACER_JIRA_DOMAIN=gone", env, impl), (err: unknown) => {
    assert.ok(err instanceof SecretsError);
    assert.deepEqual(err.failures, ["TRACER_JIRA_DOMAIN (secret gone): HTTP 404"]);
    assert.ok(!err.message.includes("SECRET-VALUE"));
    return true;
  });
  assert.equal(env.TRACER_POSTHOG_HOST, undefined);

  const denied = fakeFetch({}, 403);
  await assert.rejects(loadSecrets("TRACER_JIRA_EMAIL=x", { GOOGLE_CLOUD_PROJECT: "p" }, denied.impl), /TRACER_JIRA_EMAIL \(secret x\): HTTP 403/);
});

test("a failing metadata server fails every entry", async () => {
  const impl = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  await assert.rejects(loadSecrets("TRACER_ANTHROPIC_API_KEY=a,TRACER_GOOGLE_API_KEY=b", {}, impl), (err: unknown) => {
    assert.ok(err instanceof SecretsError);
    assert.equal(err.failures.length, 2);
    assert.match(err.failures[0], /TRACER_ANTHROPIC_API_KEY \(secret a\): metadata server: connect ECONNREFUSED/);
    return true;
  });
});

test("an empty spec does nothing", async () => {
  assert.deepEqual(await loadSecrets(" , ", {}, (async () => { throw new Error("no call"); }) as unknown as typeof fetch), []);
});

test("a secret that holds only a newline fails closed", async () => {
  const { impl } = fakeFetch({ "p/a/latest": " \n\n" });
  const env: Record<string, string | undefined> = { GOOGLE_CLOUD_PROJECT: "p" };
  await assert.rejects(loadSecrets("TRACER_ANTHROPIC_API_KEY=a", env, impl), /TRACER_ANTHROPIC_API_KEY \(secret a\): secret is empty/);
  assert.equal(env.TRACER_ANTHROPIC_API_KEY, undefined);
});

test("applySecretsJson sets known names and refuses the rest", () => {
  const env: Record<string, string | undefined> = {};
  assert.deepEqual(applySecretsJson('{"TRACER_DB_KEY":"k","TRACER_JIRA_EMAIL":"e"}', env), ["TRACER_DB_KEY", "TRACER_JIRA_EMAIL"]);
  assert.deepEqual(env, { TRACER_DB_KEY: "k", TRACER_JIRA_EMAIL: "e" });
  for (const bad of ['{"NODE_OPTIONS":"x"}', '{"TRACER_DB_KEY":"k","TRACER_HOME":"/x"}', '{"TRACER_DB_KEY":" "}', '{"TRACER_DB_KEY":1}', "[]", "null"]) {
    const untouched: Record<string, string | undefined> = {};
    assert.throws(() => applySecretsJson(bad, untouched), bad);
    assert.deepEqual(untouched, {});
  }
});

test("the server removes every name the preload accepts", async () => {
  const { seedConfigFromEnv } = await import("./db/env-config.js");
  const { createNodeDb } = await import("./db/node-db.js");
  const { runSetup } = await import("./db/setup.js");
  const Database = (await import("better-sqlite3-multiple-ciphers")).default;
  const { db, setupDriver } = createNodeDb(new Database(":memory:"));
  await runSetup(setupDriver);
  const env: Record<string, string | undefined> = Object.fromEntries([...SECRET_NAMES].map((n) => [n, "x"]));
  const log = console.log, warn = console.warn;
  console.log = console.warn = () => {};
  try { await seedConfigFromEnv(db, env); } finally { console.log = log; console.warn = warn; }
  // db/client.ts removes the database key.
  assert.deepEqual(Object.keys(env), ["TRACER_DB_KEY"]);
});

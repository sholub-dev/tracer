import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSecrets, parseSecretSpec, SecretsError } from "./gcp-secrets.js";

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
  assert.deepEqual(parseSecretSpec(" TRACER_A = s1 , TRACER_B=projects/p/secrets/s2:7,, TRACER_C=s3:latest "), [
    { envName: "TRACER_A", project: null, secret: "s1", version: "latest" },
    { envName: "TRACER_B", project: "p", secret: "s2", version: "7" },
    { envName: "TRACER_C", project: null, secret: "s3", version: "latest" },
  ]);
});

test("rejects malformed entries", () => {
  for (const bad of ["TRACER_X", "TRACER_X=", "=s", "TRACER_X=bad id!", "TRACER_X=s:v1", "TRACER_X=projects/p/s",
    "NODE_OPTIONS=s", "PATH=s", "tracer_x=s", "TRACER_HOST=s", "TRACER_HOME=s", "TRACER_TOKEN=s", "TRACER_SECRETS=s"]) {
    assert.throws(() => parseSecretSpec(bad), /malformed entry/, bad);
  }
});

test("loads secrets into env and strips one trailing newline", async () => {
  const { impl, calls } = fakeFetch({ "p/a/latest": "one\n", "p/b/3": "two\r\n", "p/c/latest": "three\n\n" });
  const env: Record<string, string | undefined> = { GOOGLE_CLOUD_PROJECT: "p" };
  const names = await loadSecrets("TRACER_A=a,TRACER_B=b:3,TRACER_C=c", env, impl);
  assert.deepEqual(names, ["TRACER_A", "TRACER_B", "TRACER_C"]);
  assert.equal(env.TRACER_A, "one");
  assert.equal(env.TRACER_B, "two");
  assert.equal(env.TRACER_C, "three\n");
  const secretCall = calls.find((c) => c.url.includes("secretmanager"))!;
  assert.equal(secretCall.headers.Authorization, "Bearer tok");
  assert.equal(calls.find((c) => c.url.includes("/token"))!.headers["Metadata-Flavor"], "Google");
});

test("takes the project from the metadata server when GOOGLE_CLOUD_PROJECT is unset", async () => {
  const { impl, calls } = fakeFetch({ "meta-proj/a/latest": "v" });
  const env: Record<string, string | undefined> = { GCE_METADATA_HOST: "meta.test" };
  await loadSecrets("TRACER_A=a", env, impl);
  assert.equal(env.TRACER_A, "v");
  assert.ok(calls.some((c) => c.url === "http://meta.test/computeMetadata/v1/project/project-id"));
});

test("GOOGLE_CLOUD_PROJECT and full names skip the project lookup", async () => {
  const { impl, calls } = fakeFetch({ "other/a/latest": "v" });
  await loadSecrets("TRACER_A=projects/other/secrets/a", {}, impl);
  assert.ok(!calls.some((c) => c.url.endsWith("/project/project-id")));
});

test("a 404 and a 403 fail closed, name each secret and leave env unset", async () => {
  const { impl } = fakeFetch({ "p/ok/latest": "SECRET-VALUE" }, 404);
  const env: Record<string, string | undefined> = { GOOGLE_CLOUD_PROJECT: "p" };
  await assert.rejects(loadSecrets("TRACER_OK=ok,TRACER_GONE=gone", env, impl), (err: unknown) => {
    assert.ok(err instanceof SecretsError);
    assert.deepEqual(err.failures, ["TRACER_GONE (secret gone): HTTP 404"]);
    assert.ok(!err.message.includes("SECRET-VALUE"));
    return true;
  });
  assert.equal(env.TRACER_OK, undefined);

  const denied = fakeFetch({}, 403);
  await assert.rejects(loadSecrets("TRACER_X=x", { GOOGLE_CLOUD_PROJECT: "p" }, denied.impl), /TRACER_X \(secret x\): HTTP 403/);
});

test("a failing metadata server fails every entry", async () => {
  const impl = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
  await assert.rejects(loadSecrets("TRACER_A=a,TRACER_B=b", {}, impl), (err: unknown) => {
    assert.ok(err instanceof SecretsError);
    assert.equal(err.failures.length, 2);
    assert.match(err.failures[0], /TRACER_A \(secret a\): metadata server: connect ECONNREFUSED/);
    return true;
  });
});

test("an empty spec does nothing", async () => {
  assert.deepEqual(await loadSecrets(" , ", {}, (async () => { throw new Error("no call"); }) as unknown as typeof fetch), []);
});

test("a secret that holds only a newline fails closed", async () => {
  const { impl } = fakeFetch({ "p/a/latest": "\n" });
  const env: Record<string, string | undefined> = { GOOGLE_CLOUD_PROJECT: "p" };
  await assert.rejects(loadSecrets("TRACER_A=a", env, impl), /TRACER_A \(secret a\): secret is empty/);
  assert.equal(env.TRACER_A, undefined);
});

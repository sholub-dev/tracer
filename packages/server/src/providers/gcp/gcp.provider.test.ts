import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGcpAuthCache } from "./gcp-auth.js";
import { GcpProvider } from "./gcp.provider.js";

test("ping fails and clears the token cache when the API rejects the token", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "gcp-ping-")), "adc.json");
  writeFileSync(path, JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" }));
  const savedEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const savedFetch = globalThis.fetch;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  clearGcpAuthCache();
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "reauth related error" } }), { status: 401 });
  }) as typeof fetch;
  try {
    const provider = new GcpProvider({ command: "x", args: [] } as never, { projectId: "p" });
    provider.connected = true;
    const result = await provider.ping();
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /gcloud auth application-default login/);
    assert.equal(provider.connected, false);
    await provider.ping();
    assert.equal(urls.filter((u) => u.includes("oauth2")).length, 2);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedEnv;
    clearGcpAuthCache();
  }
});

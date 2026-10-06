import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGcpAuthCache, getGcpAuth } from "./gcp-auth.js";

test("concurrent getGcpAuth calls share one token exchange", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "gcp-auth-")), "adc.json");
  writeFileSync(path, JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" }));
  const savedEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const savedFetch = globalThis.fetch;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  clearGcpAuthCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
  }) as typeof fetch;
  try {
    const [a, b] = await Promise.all([getGcpAuth(), getGcpAuth()]);
    assert.equal(calls, 1);
    assert.deepEqual(a, { ok: true, token: "tok" });
    assert.deepEqual(b, a);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedEnv;
    clearGcpAuthCache();
  }
});

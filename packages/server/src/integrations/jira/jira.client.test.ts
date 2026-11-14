import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient } from "./jira.client.js";

test("a Jira request does not follow a redirect", async () => {
  const realFetch = globalThis.fetch;
  let init: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, i?: RequestInit) => { init = i; return new Response("{}"); }) as typeof fetch;
  try {
    assert.deepEqual(await new JiraClient({ domain: "example", email: "a@b.c", apiToken: "t" }).validate(), { ok: true });
    assert.equal(init?.redirect, "error");
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG } from "../../config.js";
import { clearGcpAuthCache } from "./gcp-auth.js";
import { createGcpDirectTools } from "./tools.js";
import { McpProvider } from "../../mcp/mcp-provider.js";

async function withAuth(run: () => Promise<void>) {
  const path = join(mkdtempSync(join(tmpdir(), "gcp-tools-")), "adc.json");
  writeFileSync(path, JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" }));
  const savedEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const savedFetch = globalThis.fetch;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path;
  clearGcpAuthCache();
  globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS; else process.env.GOOGLE_APPLICATION_CREDENTIALS = savedEnv;
    clearGcpAuthCache();
  }
}

function hungTool() {
  const seen: { signal?: AbortSignal } = {};
  const provider = {
    invalidated: 0,
    getCachedTools: () => ({ list_log_entries: { description: "d", inputSchema: z.object({}), execute: (_i: unknown, o?: { abortSignal?: AbortSignal }) => { seen.signal = o?.abortSignal; return new Promise(() => {}); } } }),
    callsRunning: 0,
    invalidateTools() { this.invalidated++; },
  };
  const { tools } = createGcpDirectTools(provider as never, undefined, undefined, "p");
  return { run: (tools.list_log_entries as any).execute as (i: unknown, o?: unknown) => Promise<unknown>, seen, provider };
}

test("a tool call that never answers ends with an error after the limit", async () => {
  const config = CONFIG as { mcpToolCallTimeoutMs: number };
  const saved = config.mcpToolCallTimeoutMs;
  config.mcpToolCallTimeoutMs = 30;
  try {
    await withAuth(async () => {
      const { run, seen, provider } = hungTool();
      const out = await run({}, {}) as { error: string };
      assert.match(out.error, /timed out/);
      assert.equal(seen.signal?.aborted, true);
      assert.equal(provider.invalidated, 1);
    });
  } finally {
    config.mcpToolCallTimeoutMs = saved;
  }
});

test("the caller's abort ends a tool call that never answers", async () => {
  await withAuth(async () => {
    const { run } = hungTool();
    const ac = new AbortController();
    const pending = run({}, { abortSignal: ac.signal }) as Promise<{ error: string }>;
    setTimeout(() => ac.abort(new Error("stopped")), 20);
    assert.match((await pending).error, /stopped/);
  });
});

test("a call that hits the limit leaves the clients open while another call still runs", async () => {
  const config = CONFIG as { mcpToolCallTimeoutMs: number };
  const saved = config.mcpToolCallTimeoutMs;
  config.mcpToolCallTimeoutMs = 30;
  try {
    await withAuth(async () => {
      const p = new McpProvider({ label: "X", servers: [] } as never, {}, "x");
      let closed = 0;
      const tools = {
        hung: { description: "d", inputSchema: z.object({}), execute: () => new Promise(() => {}) },
        slow: { description: "d", inputSchema: z.object({}), execute: async () => { await new Promise((r) => setTimeout(r, 25)); return { content: [{ type: "text", text: "late" }] }; } },
      };
      (p as any).clients = [{ tools: async () => tools, close: async () => { closed++; } }];
      await p.getMcpTools();
      p.connected = true;
      const kit = createGcpDirectTools(p, undefined, undefined, "p").tools as Record<string, { execute: (i: unknown, o?: unknown) => Promise<{ error?: string }> }>;
      const hungCall = kit.hung.execute({}, {});
      await new Promise((r) => setTimeout(r, 15));
      const [hung, slow] = await Promise.all([hungCall, kit.slow.execute({}, {})]);
      assert.match(hung.error!, /timed out/);
      assert.equal(slow.error, undefined);
      assert.equal(closed, 0);
      assert.equal(p.connected, false);
      clearTimeout((p as any).idleTimer);
    });
  } finally {
    config.mcpToolCallTimeoutMs = saved;
  }
});

function toolReturning(result: unknown) {
  const provider = {
    connected: true,
    callsRunning: 0,
    invalidateTools() {},
    getCachedTools: () => ({ list_log_entries: { description: "d", inputSchema: z.object({}), execute: async () => result } }),
  };
  const { tools } = createGcpDirectTools(provider as never, undefined, undefined, "p");
  return { run: (tools.list_log_entries as any).execute as (i: unknown, o?: unknown) => Promise<{ error?: string; analysis?: string }>, provider };
}

test("an error object in the result text becomes an error and triggers reauth handling", async () => {
  await withAuth(async () => {
    const text = JSON.stringify({ error: { name: "Error", message: "Failed to list log entries: invalid_grant", stack: "at x" } });
    const { run, provider } = toolReturning({ content: [{ type: "text", text }] });
    const out = await run({}, {});
    assert.equal(out.error, "Failed to list log entries: invalid_grant");
    assert.equal(provider.connected, false);
  });
});

test("a bare error string from a failed call becomes an error", async () => {
  await withAuth(async () => {
    const { run } = toolReturning({ isError: true, content: [{ type: "text", text: "Request failed" }] });
    assert.equal((await run({}, {})).error, "Request failed");
  });
});

test("a normal result still formats", async () => {
  await withAuth(async () => {
    const { run } = toolReturning({ content: [{ type: "text", text: JSON.stringify([{ timestamp: "t", textPayload: "hi" }]) }] });
    const out = await run({}, {});
    assert.equal(out.error, undefined);
    assert.ok(out.analysis?.includes("hi"));
  });
});

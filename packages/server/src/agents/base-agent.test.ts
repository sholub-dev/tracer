import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ToolSet, UIMessage, UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { readUIMessageStream, streamText, tool } from "ai";
import { z } from "zod";
import type { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import * as schema from "../db/schema.js";
import type { Db } from "../db/client.js";
import { writeAppSetting } from "../db/config-reader.js";
import { SETTINGS_KEYS } from "../config.js";
import type { Context } from "../trpc/context.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { runChatAgent } from "./base-agent.js";
import { getCurrentDateBlock, getCurrentTimeText } from "../lib/current-context.js";
import { stampSentTime, withPromptCaching, withSentTimes } from "../llm/prompt-cache.js";

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const MINUTE = /\d{1,2}:\d{2}/;
const DATE_LINE_WITHOUT_TIME = /## Current Date\n[^\n:]+\n/;

function memoryDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE provider_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL UNIQUE, config TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
      kind TEXT, summary TEXT, summary_up_to INTEGER, summary_created_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL, model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, created_at INTEGER NOT NULL);
  `);
  return drizzle(sqlite, { schema }) as unknown as Db;
}

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const MESSAGE_START: [string, unknown] = ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
const end = (stopReason: string): [string, unknown][] => [
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
];
const SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } }],
  ...end("end_turn"),
]);
const TOOL_CALL_SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
  ...end("tool_use"),
]);
const MID_STREAM_ERROR_SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an answer" } }],
  ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
]);

/** `fail` first requests get a non-retryable API error; `hold` never answers; `script` sets each request's SSE body (null fails it). */
function fakeAnthropic({ fail = 0, hold = false, script = [] as (string | null)[] } = {}): Promise<{ server: Server; url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      if (hold) return;
      if (bodies.length <= fail || script[bodies.length - 1] === null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "boom" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(script[bodies.length - 1] ?? SSE);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies });
  }));
}

test("system date block has no clock time; the time text does", () => {
  assert.match(getCurrentDateBlock(), DATE_LINE_WITHOUT_TIME);
  assert.match(getCurrentTimeText(), MINUTE);
});

test("send time is stamped once on the newest user message and replayed unchanged on later turns", () => {
  const turn1: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "first" }] }];
  const snapshot = structuredClone(turn1);
  const stamped = stampSentTime(turn1, "[t1]");
  assert.deepEqual(turn1, snapshot);
  assert.deepEqual(stampSentTime(stamped, "[t2]"), stamped, "never restamped");

  const turn2 = stampSentTime([...stamped, { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "second" }] }], "[t2]");
  const model = withSentTimes(turn2);
  assert.deepEqual(model[0].parts, [{ type: "text", text: "first" }, { type: "text", text: "[t1]" }]);
  assert.deepEqual(model[1], turn2[1]);
  assert.deepEqual(model[2].parts, [{ type: "text", text: "second" }, { type: "text", text: "[t2]" }]);
});

test("non-Anthropic models get plain instructions and untouched provider options", async () => {
  const opts = { google: { thinkingConfig: { thinkingBudget: 1 } } };
  const cached = withPromptCaching("google", "SYS", opts);
  assert.equal(cached.instructions, "SYS");
  assert.equal(cached.providerOptions, opts);

  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  });
  const r = streamText({ model, instructions: cached.instructions, prompt: "hi", providerOptions: cached.providerOptions, onError: () => {} });
  await r.consumeStream({ onError: () => {} });
  const call = model.doStreamCalls[0];
  assert.deepEqual(call.prompt[0], { role: "system", content: "SYS" });
  assert.deepEqual(call.providerOptions, opts);
});

test("Anthropic chat request: date-only system prompt with cache breakpoint, time on last user turn, automatic caching on", async () => {
  const { server, url, bodies } = await fakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const db = memoryDb();
    db.insert(schema.providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "test" }) }).run();
    writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-test" });
    const context: Context = { db, providers: {} as ProviderRegistry, activeStreams: new Map() };
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "earlier question" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "earlier answer" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "why is checkout slow?" }] },
    ];
    const res = await runChatAgent({
      sessionId: "s1", messages, context,
      collectTools: () => ({ tools: undefined }),
      sessionTitle: () => "t",
    });
    assert.ok("stream" in res && res.stream);
    const reader = res.stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    for (let i = 0; i < 50 && context.activeStreams.size > 0; i++) await new Promise((r) => setTimeout(r, 20));

    assert.equal(bodies.length, 1);
    const body = bodies[0] as {
      system: Array<{ text: string; cache_control?: unknown }>;
      messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      cache_control?: unknown;
      thinking?: unknown;
    };
    assert.equal(body.system.length, 1);
    assert.match(body.system[0].text, DATE_LINE_WITHOUT_TIME);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(body.cache_control, { type: "ephemeral" });
    assert.ok(body.thinking, "thinking option still merged in");

    const last = body.messages[body.messages.length - 1];
    assert.equal(last.role, "user");
    assert.equal(last.content[0].text, "why is checkout slow?");
    assert.match(last.content[1].text, /^\[Current date and time: .*\d{1,2}:\d{2}/);
    assert.equal(JSON.stringify(body.messages[0]).includes("Current date and time"), false);

    const saved = db.select().from(schema.chatSessions).get();
    const savedLastUser = (JSON.parse(saved!.messages) as UIMessage[]).filter((m) => m.role === "user").at(-1)!;
    assert.deepEqual(savedLastUser.parts, [{ type: "text", text: "why is checkout slow?" }], "time is not a visible part");
    assert.equal((savedLastUser.metadata as { sentTime: string }).sentTime, last.content[1].text, "time is kept for later turns");
    assert.equal(saved?.status, "done");
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
});

async function retryRun(fake: { fail?: number; hold?: boolean; script?: (string | null)[] }, retryDelaysMs: number[], whileRunning?: (ctx: Context) => Promise<void>, tools?: ToolSet) {
  const { server, url, bodies } = await fakeAnthropic(fake);
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const db = memoryDb();
    db.insert(schema.providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "test" }) }).run();
    writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-test" });
    const context: Context = { db, providers: {} as ProviderRegistry, activeStreams: new Map() };
    let completed = 0;
    const failed: string[] = [];
    const res = await runChatAgent({
      sessionId: "s1", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "why?" }] }], context,
      collectTools: () => ({ tools, afterComplete: () => { completed++; } }),
      sessionTitle: () => "t", retryDelaysMs, onFailed: (e) => failed.push(e),
    });
    assert.ok("stream" in res && res.stream);
    const parts: UIMessageChunk[] = [];
    const draining = (async () => {
      const reader = res.stream.getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(r.value);
    })();
    await whileRunning?.(context);
    await draining;
    const saved = JSON.parse(db.select().from(schema.chatSessions).get()!.messages) as UIMessage[];
    return { bodies, completed, failed, parts, saved, status: db.select().from(schema.chatSessions).get()?.status };
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
}

test("a failed attempt is re-run on the same history and completes once", async () => {
  const r = await retryRun({ fail: 2 }, [0, 0, 0]);
  assert.equal(r.bodies.length, 3);
  for (const b of r.bodies) assert.equal((b.messages as unknown[]).length, 1, "the user message is sent once");
  assert.equal(r.completed, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 0, "retried errors are not shown");
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"]);
  assert.equal(r.status, "done");
});

test("when every attempt fails the run reports one failure and one error", async () => {
  const r = await retryRun({ fail: 99 }, [0, 0]);
  assert.equal(r.bodies.length, 3);
  assert.equal(r.completed, 0);
  assert.deepEqual(r.failed, ["boom"]);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 1);
  assert.deepEqual(r.saved.map((m) => m.role), ["user"]);
  assert.equal(r.status, "done");
});

test("a stop is never retried", async () => {
  const stopped = await retryRun({ hold: true }, [0, 0], async (ctx) => {
    await new Promise((r) => setTimeout(r, 100));
    ctx.activeStreams.get("s1")!.controller.abort();
  });
  assert.equal(stopped.bodies.length, 1);
  assert.deepEqual(stopped.failed, []);

  const started = Date.now();
  const inBackoff = await retryRun({ fail: 99 }, [60_000], async (ctx) => {
    await new Promise((r) => setTimeout(r, 300));
    ctx.activeStreams.get("s1")!.controller.abort();
  });
  assert.equal(inBackoff.bodies.length, 1);
  assert.deepEqual(inBackoff.failed, [], "a stop while waiting is not a failure");
  assert.ok(Date.now() - started < 10_000);
});

test("a retried attempt's streamed steps are dropped for live and late viewers", async () => {
  let broadcaster!: StreamBroadcaster;
  const r = await retryRun(
    { script: [TOOL_CALL_SSE, TOOL_CALL_SSE, null, TOOL_CALL_SSE] }, [0],
    async (ctx) => { broadcaster = ctx.activeStreams.get("s1")!.broadcaster; },
    { lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
  );
  assert.equal(r.bodies.length, 5);
  assert.equal(r.parts.filter((p) => p.type === "reset-step").length, 1);

  const render = async (chunks: UIMessageChunk[]) => {
    let last: UIMessage | undefined;
    for await (const m of readUIMessageStream({ stream: new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }) })) last = m;
    return last!.parts.filter((p) => p.type !== "step-start").map((p) => p.type === "text" ? p.text : p.type);
  };
  const expected = ["tool-lookup", "Hi there"];
  assert.deepEqual(await render(r.parts), expected, "live viewer");
  const replay: UIMessageChunk[] = [];
  broadcaster.subscribe((p) => replay.push(p as UIMessageChunk));
  assert.equal(replay.some((p) => p.type === "reset-step"), false);
  assert.deepEqual(await render(replay), expected, "late viewer");
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"]);
});

test("a mid-stream model error is a failed attempt: retried, not saved", async () => {
  const r = await retryRun({ script: [MID_STREAM_ERROR_SSE] }, [0]);
  assert.equal(r.bodies.length, 2);
  assert.equal(r.parts.filter((p) => p.type === "reset-step").length, 1);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 0);
  assert.deepEqual(r.failed, []);
  assert.equal(r.completed, 1);
  const assistant = r.saved.filter((m) => m.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.deepEqual(assistant[0].parts.filter((p) => p.type === "text").map((p) => p.type === "text" && p.text), ["Hi there"]);
});

test("when every attempt ends in a mid-stream model error the run fails once and shows one error", async () => {
  const r = await retryRun({ script: [MID_STREAM_ERROR_SSE, MID_STREAM_ERROR_SSE, MID_STREAM_ERROR_SSE] }, [0, 0]);
  assert.equal(r.bodies.length, 3);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0], /Overloaded/);
  assert.equal(r.completed, 0);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 1);
  assert.deepEqual(r.saved.map((m) => m.role), ["user"]);
});

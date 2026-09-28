import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3-multiple-ciphers";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { streamText } from "ai";
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

const SSE = [
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

function fakeAnthropic(): Promise<{ server: Server; url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
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

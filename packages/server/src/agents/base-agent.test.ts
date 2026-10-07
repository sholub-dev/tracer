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
import { decodeMessages } from "../lib/messages-codec.js";
import type { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import * as schema from "../db/schema.js";
import type { Db } from "../db/driver.js";
import { writeAppSetting } from "../db/config-reader.js";
import { SETTINGS_KEYS } from "../config.js";
import type { Context } from "../trpc/context.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { runChatAgent, sanitizeMessages } from "./base-agent.js";
import { resumeRuns, settleInterruptedRuns } from "./resume.js";
import { ProviderRegistry as Registry } from "../providers/registry.js";
import { encodeMessages } from "../lib/messages-codec.js";
import { UNIFIED_SCOPE } from "@tracer-sh/shared";
import { reportFindingTool } from "../tools/finding-tool.js";
import { CONFIG } from "../config.js";
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
      kind TEXT, summary TEXT, summary_up_to INTEGER, summary_created_at INTEGER, run_scope TEXT, resumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tool_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, note TEXT NOT NULL, review_note TEXT, uid TEXT, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE monitor_triggers (id TEXT PRIMARY KEY, monitor_id TEXT, triggered_at INTEGER, window_start INTEGER NOT NULL, session_id TEXT, reported TEXT);
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
const TWO_TOOL_CALLS_SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "slow", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
]);
const MID_STREAM_ERROR_SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an answer" } }],
  ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
]);

/** A mid-stream error of a type the provider does not know. */
const UNKNOWN_ERROR_SSE = MID_STREAM_ERROR_SSE.replace("overloaded_error", "unexpected_error").replace("Overloaded", "odd failure");

/** A script entry that sends part of an answer, then drops the connection. */
const DROPPED = "dropped";
/** A script entry that sends part of an answer, then never finishes. */
const STALLED = "stalled";

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
      if (script[bodies.length - 1] === STALLED) {
        res.write(MID_STREAM_ERROR_SSE.slice(0, MID_STREAM_ERROR_SSE.lastIndexOf("event: error")));
        return;
      }
      if (script[bodies.length - 1] === DROPPED) {
        res.write(MID_STREAM_ERROR_SSE.slice(0, MID_STREAM_ERROR_SSE.lastIndexOf("event: error")));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.end(script[bodies.length - 1] ?? SSE);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies });
  }));
}

test("system date block has no clock time; the time text does", async () => {
  assert.match(await getCurrentDateBlock(), DATE_LINE_WITHOUT_TIME);
  assert.match(await getCurrentTimeText(), MINUTE);
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
    await db.insert(schema.providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "test" }) }).run();
    await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-test" });
    const context: Context = { db, providers: {} as ProviderRegistry, activeStreams: new Map() };
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "earlier question" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "earlier answer" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "why is checkout slow?" }] },
    ];
    const res = await runChatAgent({
      sessionId: "s1", messages, context,
      collectTools: async () => ({ tools: undefined }),
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

    const saved = await db.select().from(schema.chatSessions).get();
    const savedLastUser = decodeMessages(saved!.messages).filter((m) => m.role === "user").at(-1)!;
    assert.deepEqual(savedLastUser.parts, [{ type: "text", text: "why is checkout slow?" }], "time is not a visible part");
    assert.equal((savedLastUser.metadata as { sentTime: string }).sentTime, last.content[1].text, "time is kept for later turns");
    assert.equal(saved?.status, "done");
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
});

async function retryRun(fake: { fail?: number; hold?: boolean; script?: (string | null)[] }, retryDelaysMs: number[], whileRunning?: (ctx: Context) => Promise<void>, tools?: ToolSet | ((writer: { write: (part: Record<string, unknown>) => void }) => ToolSet)) {
  const { server, url, bodies } = await fakeAnthropic(fake);
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const db = memoryDb();
    await db.insert(schema.providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "test" }) }).run();
    await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-test" });
    const context: Context = { db, providers: {} as ProviderRegistry, activeStreams: new Map() };
    let completed = 0;
    const failed: string[] = [];
    const res = await runChatAgent({
      sessionId: "s1", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "why?" }] }], context,
      collectTools: async (writer) => ({ tools: typeof tools === "function" ? tools(writer) : tools, afterComplete: () => { completed++; } }),
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
    const row = await db.select().from(schema.chatSessions).get();
    const saved = decodeMessages(row!.messages);
    const runs = await db.select().from(schema.agentRuns).all();
    return { bodies, completed, failed, parts, saved, status: row?.status, runs };
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
}

test("a transient failure is re-run on the same history and completes once", async () => {
  const r = await retryRun({ script: [MID_STREAM_ERROR_SSE, MID_STREAM_ERROR_SSE, SSE] }, [0, 0, 0]);
  assert.equal(r.bodies.length, 3);
  for (const b of r.bodies) assert.equal((b.messages as unknown[]).length, 1, "the user message is sent once");
  assert.equal(r.completed, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 0, "retried errors are not shown");
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"]);
  assert.equal(r.status, "done");
});

test("a failure of an unknown kind is re-run", async () => {
  const r = await retryRun({ script: [UNKNOWN_ERROR_SSE, SSE] }, [0]);
  assert.equal(r.bodies.length, 2);
  assert.equal(r.completed, 1);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"]);
});

test("a non-transient failure is not re-run: one failure, one error, nothing to save", async () => {
  const r = await retryRun({ fail: 99 }, [0, 0]);
  assert.equal(r.bodies.length, 1);
  assert.equal(r.completed, 0);
  assert.deepEqual(r.failed, ["boom"]);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 1);
  assert.deepEqual(r.saved.map((m) => m.role), ["user"], "a failed reply without parts adds no message");
  assert.equal(r.status, "done");
});

test("a non-transient failure after partial output ends the run at once and keeps the partial reply", async () => {
  const BAD = MID_STREAM_ERROR_SSE.replace("overloaded_error", "invalid_request_error").replace("Overloaded", "bad input");
  const r = await retryRun({ script: [BAD] }, [0, 0]);
  assert.equal(r.bodies.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 1, "the client still gets the error");
  const reply = r.saved.at(-1)!;
  assert.equal(reply.role, "assistant");
  assert.match((reply.metadata as { error: string }).error, /bad input/);
});

test("a stop is never retried", async () => {
  const stopped = await retryRun({ hold: true }, [0, 0], async (ctx) => {
    await new Promise((r) => setTimeout(r, 100));
    ctx.activeStreams.get("s1")!.controller.abort();
  });
  assert.equal(stopped.bodies.length, 1);
  assert.deepEqual(stopped.failed, []);

  const started = Date.now();
  const inBackoff = await retryRun({ script: [MID_STREAM_ERROR_SSE] }, [60_000], async (ctx) => {
    await new Promise((r) => setTimeout(r, 300));
    ctx.activeStreams.get("s1")!.controller.abort();
  });
  assert.equal(inBackoff.bodies.length, 1);
  assert.deepEqual(inBackoff.failed, [], "a stop while waiting is not a failure");
  assert.ok(Date.now() - started < 10_000);
});

test("a re-run continues after the last saved tool step; only the failed step is dropped for viewers", async () => {
  let broadcaster!: StreamBroadcaster;
  const r = await retryRun(
    { script: [TOOL_CALL_SSE, TOOL_CALL_SSE, DROPPED, TOOL_CALL_SSE] }, [0],
    async (ctx) => { broadcaster = ctx.activeStreams.get("s1")!.broadcaster; },
    { lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
  );
  assert.equal(r.bodies.length, 5);
  assert.equal((r.bodies[3].messages as unknown[]).length, (r.bodies[2].messages as unknown[]).length, "the re-run sends the saved tool steps");
  assert.equal(r.parts.filter((p) => p.type === "reset-step").length, 1);

  const render = async (chunks: UIMessageChunk[]) => {
    let last: UIMessage | undefined;
    for await (const m of readUIMessageStream({ stream: new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }) })) last = m;
    return last!.parts.filter((p) => p.type !== "step-start").map((p) => p.type === "text" ? p.text : p.type);
  };
  const expected = ["tool-lookup", "tool-lookup", "tool-lookup", "Hi there"];
  assert.deepEqual(await render(r.parts), expected, "live viewer");
  const replay: UIMessageChunk[] = [];
  broadcaster.subscribe((p) => replay.push(p as UIMessageChunk));
  assert.equal(replay.some((p) => p.type === "reset-step"), false);
  assert.deepEqual(await render(replay), expected, "late viewer");
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"]);
});

const EMPTY_TEXT_SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }],
  ...end("end_turn"),
]);
const FINDING_CALL_SSE = sse([
  MESSAGE_START,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_f", name: "report_finding", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ kind: "summary", headline: "Checkout is slow", details: "One query ran.", points: [] }) } }],
  ...end("tool_use"),
]);
const findingTools = { lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }), report_finding: reportFindingTool() };

test("a turn that ran a query and stopped without a finding card gets one extra pass limited to report_finding", async () => {
  const r = await retryRun({ script: [TOOL_CALL_SSE, EMPTY_TEXT_SSE, FINDING_CALL_SSE, SSE] }, [], undefined, findingTools);
  assert.equal(r.bodies.length, 4);
  const toolNames = (i: number) => (r.bodies[i].tools as { name: string }[]).map((t) => t.name);
  assert.deepEqual(toolNames(1), ["lookup", "report_finding"]);
  assert.deepEqual(toolNames(2), ["report_finding"], "the first repair step offers only the card");
  assert.deepEqual(toolNames(3), ["lookup", "report_finding"], "later steps offer every tool");
  const last = r.bodies[2].messages as { role: string }[];
  assert.equal(last.at(-1)!.role, "user", "the repair request ends with a nudge, not a prefill");
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"], "the nudge is not saved");
  const types = r.saved[1].parts.map((p) => p.type);
  assert.ok(types.includes("tool-report_finding"));
  assert.equal(r.completed, 1, "follow-up work runs once, after the repair pass");
});

test("a failed repair pass still runs the follow-up work of the complete reply and reports no failure", async () => {
  const r = await retryRun({ script: [TOOL_CALL_SSE, EMPTY_TEXT_SSE, MID_STREAM_ERROR_SSE] }, [], undefined, findingTools);
  assert.equal(r.bodies.length, 3);
  assert.equal(r.completed, 1);
  assert.deepEqual(r.failed, []);
});

test("a turn that already has a finding card or ran no query gets no repair pass", async () => {
  const carded = await retryRun({ script: [TOOL_CALL_SSE, FINDING_CALL_SSE, SSE] }, [], undefined, findingTools);
  assert.equal(carded.bodies.length, 3);
  const plain = await retryRun({ script: [SSE] }, [], undefined, findingTools);
  assert.equal(plain.bodies.length, 1);
  assert.equal(plain.completed, 1);
});

test("each tool step is saved while the run goes on, and a stop keeps it", async () => {
  let midRun: string[] = [];
  let midRunId: string | undefined;
  const r = await retryRun(
    { script: [TOOL_CALL_SSE, STALLED] }, [],
    async (ctx) => {
      await new Promise((res) => setTimeout(res, 300));
      const row = await ctx.db.select().from(schema.chatSessions).get();
      const reply = decodeMessages(row!.messages).at(-1)!;
      midRun = reply.parts.map((p) => p.type);
      midRunId = reply.id;
      ctx.activeStreams.get("s1")!.controller.abort();
    },
    { lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }) },
  );
  assert.ok(midRun.includes("tool-lookup"), "the tool step is saved while the run goes on");
  assert.equal(midRunId, r.saved.at(-1)!.id, "the step save and the final save give the reply one id");
  assert.equal(r.bodies.length, 2);
  assert.ok(r.saved.at(-1)!.parts.some((p) => p.type === "tool-lookup"));
});

test("token use is recorded for each finished model call, also in failed and retried attempts", async () => {
  const lookup = { lookup: tool({ inputSchema: z.object({}), execute: async () => "ok" }) };
  const retried = await retryRun({ script: [TOOL_CALL_SSE, DROPPED, SSE] }, [0], undefined, lookup);
  assert.equal(retried.bodies.length, 3);
  assert.equal(retried.runs.length, 2, "the dropped call reports no usage; the other two do");
  assert.ok(retried.runs.every((r) => r.agentType === "chat" && r.inputTokens === 10 && r.outputTokens === 2));

  const failed = await retryRun({ script: [TOOL_CALL_SSE, DROPPED] }, [], undefined, lookup);
  assert.equal(failed.failed.length, 1);
  assert.equal(failed.runs.length, 1, "a failed run still counts the call that finished");
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
  const reply = r.saved.at(-1)!;
  assert.equal(reply.role, "assistant", "the partial reply of the last attempt is kept");
  assert.equal((reply.metadata as { error: string }).error, "The run failed after retries: Overloaded");
  assert.deepEqual(reply.parts.filter((p) => p.type === "text").map((p) => p.type === "text" && p.text), ["half an answer"]);
});

test("a stopped run keeps its partial reply and is not a failure", async () => {
  const r = await retryRun({ script: [STALLED] }, [0, 0], async (ctx) => {
    await new Promise((res) => setTimeout(res, 300));
    ctx.activeStreams.get("s1")!.controller.abort();
  });
  assert.equal(r.bodies.length, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(r.completed, 0, "a stopped run skips the after-complete work");
  const reply = r.saved.at(-1)!;
  assert.equal(reply.role, "assistant");
  assert.deepEqual(reply.parts.filter((p) => p.type === "text").map((p) => p.type === "text" && p.text), ["half an answer"]);
  assert.equal(reply.metadata, undefined);
});

test("a stop keeps the progress a running tool streamed", async () => {
  const r = await retryRun({ script: [TOOL_CALL_SSE] }, [0], async (ctx) => {
    await new Promise((res) => setTimeout(res, 300));
    ctx.activeStreams.get("s1")!.controller.abort();
  }, (writer) => ({
    lookup: tool({
      inputSchema: z.object({}),
      execute: async (_input, { abortSignal, toolCallId }) => {
        const send = (part: unknown) => writer.write({ type: "data-provider-part", data: { toolCallId, part } });
        send({ type: "text-delta", delta: "checking " });
        send({ type: "text-delta", delta: "logs" });
        send({ type: "query", query: "SELECT 1", results: [] });
        await new Promise((res) => abortSignal?.addEventListener("abort", res));
        return "late";
      },
    }),
  }));
  const toolPart = r.saved.at(-1)!.parts.find((p) => p.type === "tool-lookup") as { state: string; output: unknown };
  assert.equal(toolPart.state, "output-available");
  assert.deepEqual(toolPart.output, { parts: [{ type: "text", content: "checking logs" }, { type: "query", query: "SELECT 1", results: [] }] });
});

test("a connection dropped mid-stream on the last attempt fails the run and shows one error", async () => {
  const r = await retryRun({ script: [DROPPED, DROPPED] }, [0]);
  assert.equal(r.bodies.length, 2);
  assert.equal(r.failed.length, 1);
  assert.equal(r.completed, 0);
  assert.equal(r.parts.filter((p) => p.type === "error").length, 1);
  assert.deepEqual(r.saved.map((m) => m.role), ["user", "assistant"]);
  assert.equal(r.status, "done");
});

test("sanitizeMessages settles unfinished tool parts, keeps errors, and puts begin_analysis after its step's tools", () => {
  const part = (type: string, state: string, extra: object = {}) => ({ type, toolCallId: type + state, state, input: {}, ...extra });
  const [msg] = sanitizeMessages([{ id: "", role: "assistant", parts: [
    { type: "step-start" },
    part("tool-a", "output-error", { errorText: "bad" }),
    part("tool-b", "input-available"),
    part("tool-c", "input-streaming"),
    part("tool-d", "output-available", { output: "ok" }),
  ] as UIMessage["parts"] }]);
  const [, a, b, c, d] = msg.parts as unknown as Record<string, unknown>[];
  assert.equal(a.state, "output-error");
  assert.equal(a.errorText, "bad");
  assert.deepEqual([b.state, b.output], ["output-available", { error: "Aborted" }]);
  assert.deepEqual([c.state, c.output], ["output-available", { error: "Aborted" }]);
  assert.equal(d.output, "ok");

  const [moved] = sanitizeMessages([{ id: "", role: "assistant", parts: [
    { type: "step-start" }, part("tool-x", "output-available"),
    { type: "step-start" }, part("tool-begin_analysis", "output-available"), part("tool-q1", "output-available"), part("tool-q2", "output-available"), { type: "text", text: "done" },
  ] as UIMessage["parts"] }]);
  assert.deepEqual(moved.parts.map((p) => p.type), ["step-start", "tool-x", "step-start", "tool-q1", "tool-q2", "tool-begin_analysis", "text"]);

  const [later] = sanitizeMessages([{ id: "", role: "assistant", parts: [
    { type: "step-start" }, part("tool-begin_analysis", "output-available"), part("tool-q1", "output-available"),
    { type: "step-start" }, part("tool-q2", "output-available"), { type: "text", text: "done" },
  ] as UIMessage["parts"] }]);
  assert.deepEqual(later.parts.map((p) => p.type), ["step-start", "tool-q1", "tool-begin_analysis", "step-start", "tool-q2", "text"]);
});

test("two tool calls in one step run together, are saved in one step, and a stop settles only the unfinished one", async () => {
  const done = await retryRun(
    { script: [TWO_TOOL_CALLS_SSE, SSE] }, [],
    undefined,
    { lookup: tool({ inputSchema: z.object({}), execute: async () => "a" }), slow: tool({ inputSchema: z.object({}), execute: async () => "b" }) },
  );
  const toolParts = done.saved.at(-1)!.parts.filter((p) => p.type.startsWith("tool-")) as { type: string; state: string; output: unknown }[];
  assert.deepEqual(toolParts.map((p) => [p.type, p.state, p.output]), [["tool-lookup", "output-available", "a"], ["tool-slow", "output-available", "b"]]);
  assert.equal(done.bodies.length, 2);
  const results = ((done.bodies[1].messages as { content: { type: string }[] }[]).at(-1)!.content).filter((c) => c.type === "tool_result");
  assert.equal(results.length, 2, "both results go back in one turn");

  let midRun: { type: string; state: string }[] = [];
  const stopped = await retryRun(
    { script: [TWO_TOOL_CALLS_SSE] }, [],
    async (ctx) => {
      await new Promise((res) => setTimeout(res, 400));
      const row = await ctx.db.select().from(schema.chatSessions).get();
      midRun = decodeMessages(row!.messages).at(-1)!.parts.filter((p) => p.type.startsWith("tool-")) as typeof midRun;
      ctx.activeStreams.get("s1")!.controller.abort();
    },
    {
      lookup: tool({ inputSchema: z.object({}), execute: async () => "a" }),
      slow: tool({ inputSchema: z.object({}), execute: (_i, { abortSignal }) => new Promise((res) => abortSignal?.addEventListener("abort", () => res("late"))) }),
    },
  );
  assert.deepEqual(midRun, [], "an unfinished step is not saved mid-run");
  const parts = stopped.saved.at(-1)!.parts.filter((p) => p.type.startsWith("tool-")) as { type: string; state: string; output: unknown }[];
  assert.deepEqual(parts.map((p) => [p.type, p.output]), [["tool-lookup", "a"], ["tool-slow", { error: "Aborted" }]]);
});

const INTERRUPTED: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "why?" }] },
  { id: "", role: "assistant", parts: [{ type: "step-start" }, { type: "tool-lookup", toolCallId: "toolu_1", state: "output-available", input: {}, output: "ok" }] },
];

async function interruptedSession(db: Db, fields: Partial<typeof schema.chatSessions.$inferInsert> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await db.insert(schema.chatSessions).values({
    id: "s1", title: "t", messages: encodeMessages(INTERRUPTED), status: "streaming", runScope: UNIFIED_SCOPE, createdAt: now, updatedAt: now, ...fields,
  }).run();
}

async function resumeAfterRestart(db: Db, context: Context) {
  const runs = await settleInterruptedRuns(db);
  await resumeRuns(context, runs);
  while (context.activeStreams.size > 0) await new Promise((r) => setTimeout(r, 20));
  return { runs, row: await db.select().from(schema.chatSessions).get() };
}

test("a restart resumes an interrupted run from its saved step without a new user message, and only once", async () => {
  const { server, url, bodies } = await fakeAnthropic();
  process.env.ANTHROPIC_BASE_URL = url;
  try {
    const db = memoryDb();
    await db.insert(schema.providerConfigs).values({ type: "anthropic", config: JSON.stringify({ apiKey: "test" }) }).run();
    await writeAppSetting(db, SETTINGS_KEYS.chatModel, { provider: "anthropic", modelId: "claude-test" });
    const context: Context = { db, providers: new Registry(), activeStreams: new Map() };
    await interruptedSession(db);

    const first = await resumeAfterRestart(db, context);
    assert.equal(first.runs.length, 1);
    assert.equal(bodies.length, 1);
    const sent = bodies[0].messages as { role: string; content: { type: string }[] }[];
    assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "user"], "the saved tool step is sent; no user message is added");
    assert.equal(sent.at(-1)!.content[0].type, "tool_result");
    const saved = decodeMessages(first.row!.messages);
    assert.deepEqual(saved.map((m) => m.role), ["user", "assistant"]);
    assert.ok(saved[1].parts.some((p) => p.type === "tool-lookup") && saved[1].parts.some((p) => p.type === "text"), "the reply is continued");
    assert.equal(first.row!.status, "done");
    assert.equal(first.row!.resumed, 1);

    // The run is interrupted again: it ends as done and is not resumed a second time.
    await db.update(schema.chatSessions).set({ status: "streaming" }).run();
    const second = await resumeAfterRestart(db, context);
    assert.deepEqual(second.runs, []);
    assert.equal(bodies.length, 1);
    assert.equal(second.row!.status, "done");
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    server.close();
  }
});

test("a restart does not resume a stopped run, an old run or a run without a scope", async () => {
  const stopped = await retryRun({ hold: true }, [0], async (ctx) => {
    await new Promise((r) => setTimeout(r, 100));
    ctx.activeStreams.get("s1")!.controller.abort();
  });
  assert.equal(stopped.status, "done");

  const db = memoryDb();
  const old = Math.floor(Date.now() / 1000) - CONFIG.chatResumeMaxAgeSec - 60;
  await interruptedSession(db, { id: "old", updatedAt: old });
  await interruptedSession(db, { id: "unscoped", runScope: null });
  assert.deepEqual(await settleInterruptedRuns(db), []);
  const rows = await db.select().from(schema.chatSessions).all();
  assert.deepEqual(rows.map((r) => r.status), ["done", "done"]);
});

/**
 * Seed script to insert a demo session into the Tracer database
 * for README screenshots. All data is fictional.
 *
 * Usage: node scripts/seed-demo.mjs
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

const tracerHome = process.env.TRACER_HOME || join(homedir(), ".tracer");
const dbPath = join(tracerHome, "data", "tracer.db");
const db = new Database(dbPath);

const SESSION_ID = "demo-checkout-latency-spike";
const NOW = Math.floor(Date.now() / 1000);
const HOUR_AGO = NOW - 3600;

// --- Generate timeseries data ---

function makeTimeseries(startSec, count, interval, valueFn) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const begin = startSec + i * interval;
    results.push({
      beginTimeSeconds: begin,
      endTimeSeconds: begin + interval,
      ...valueFn(i, count),
    });
  }
  return results;
}

// Latency: baseline ~180-220ms, spike to 600-850ms around points 20-30 (of 60), then recovery
const latencyData = makeTimeseries(HOUR_AGO, 60, 60, (i) => {
  let base = 190 + Math.round(Math.random() * 30);
  if (i >= 20 && i <= 22) base = 350 + Math.round(Math.random() * 100); // ramp up
  if (i >= 23 && i <= 30) base = 620 + Math.round(Math.random() * 230); // peak
  if (i >= 31 && i <= 34) base = 380 + Math.round(Math.random() * 120); // ramp down
  return { average: base };
});

// Error count: baseline 2-8, spike to 40-90 during the same window
const errorData = makeTimeseries(HOUR_AGO, 60, 60, (i) => {
  let base = 2 + Math.round(Math.random() * 6);
  if (i >= 22 && i <= 31) base = 40 + Math.round(Math.random() * 50);
  if (i >= 32 && i <= 34) base = 15 + Math.round(Math.random() * 10);
  return { count: base };
});

// --- Build messages JSON (matches Vercel AI SDK UIMessage format) ---

const messages = [
  {
    parts: [
      {
        type: "text",
        text: "Can you check what's going on with checkout latency? We're getting user complaints about slow page loads.",
      },
    ],
    id: "demo-user-msg-001",
    role: "user",
  },
  {
    id: "",
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-execute_nrql",
        toolCallId: "demo-tc-001",
        state: "output-available",
        input: {
          query:
            "SELECT average(duration) FROM Transaction WHERE name = 'WebTransaction/Controller/checkout' SINCE 1 hour ago",
        },
        output: {
          parts: [
            {
              type: "query",
              query:
                "SELECT average(duration) FROM Transaction WHERE name = 'WebTransaction/Controller/checkout' SINCE 1 hour ago",
              results: [{ average: 0.347 }],
            },
          ],
          analysis: "average: 0.347s",
        },
      },
      { type: "step-start" },
      {
        type: "tool-begin_analysis",
        toolCallId: "demo-tc-002",
        state: "output-available",
        input: {},
        output: {
          status:
            "Analysis mode active. Follow the analysis rules from your system prompt.",
        },
      },
      { type: "step-start" },
      {
        type: "text",
        text: "The average checkout latency over the last hour is **347ms**, which is above your typical baseline of ~200ms. Let me get the timeseries breakdown to see when the spike occurred.\n\n",
        state: "done",
      },
      {
        type: "tool-execute_nrql",
        toolCallId: "demo-tc-003",
        state: "output-available",
        input: {
          query:
            "SELECT average(duration) FROM Transaction WHERE name = 'WebTransaction/Controller/checkout' SINCE 1 hour ago TIMESERIES",
        },
        output: {
          parts: [
            {
              type: "query",
              query:
                "SELECT average(duration) FROM Transaction WHERE name = 'WebTransaction/Controller/checkout' SINCE 1 hour ago TIMESERIES",
              results: latencyData,
            },
          ],
          analysis: latencyData
            .filter((_, i) => i % 10 === 0)
            .map(
              (d) =>
                `${new Date(d.beginTimeSeconds * 1000).toISOString().slice(11, 19)}: ${d.average}ms`
            )
            .join("\n"),
        },
      },
      { type: "step-start" },
      {
        type: "text",
        text: "There's a clear latency spike visible in the timeseries. Let me also check if there's a correlation with error rates during that window.\n\n",
        state: "done",
      },
      {
        type: "tool-execute_nrql",
        toolCallId: "demo-tc-004",
        state: "output-available",
        input: {
          query:
            "SELECT count(*) FROM TransactionError WHERE transactionName = 'WebTransaction/Controller/checkout' SINCE 1 hour ago TIMESERIES",
        },
        output: {
          parts: [
            {
              type: "query",
              query:
                "SELECT count(*) FROM TransactionError WHERE transactionName = 'WebTransaction/Controller/checkout' SINCE 1 hour ago TIMESERIES",
              results: errorData,
            },
          ],
          analysis: errorData
            .filter((_, i) => i % 10 === 0)
            .map(
              (d) =>
                `${new Date(d.beginTimeSeconds * 1000).toISOString().slice(11, 19)}: ${d.count} errors`
            )
            .join("\n"),
        },
      },
      { type: "step-start" },
      {
        type: "text",
        text: "Here's what I found:\n\n**Checkout latency spiked to 600-850ms** about 25 minutes ago, up from a baseline of ~190ms. The spike lasted approximately 10 minutes before gradually recovering.\n\n**Error rates correlate directly** with the latency spike — checkout errors jumped from a baseline of ~5/min to 40-90/min during the same window. This suggests the latency wasn't just slowness but was causing downstream failures (likely timeouts to the payment gateway or inventory service).\n\nThe spike has resolved on its own, which points to a transient issue — possibly a deployment rollout, a downstream dependency hiccup, or a burst of traffic that exceeded connection pool limits. I'd recommend checking deployment logs and the payment gateway status page for that time window.",
        state: "done",
      },
    ],
    usage: {
      model: "gemini-3-flash-preview",
      inputTokens: 18420,
      outputTokens: 215,
      reasoningTokens: 0,
      cachedInputTokens: 6800,
      cacheWriteTokens: 0,
    },
  },
];

// --- Insert into DB ---

// Delete existing demo session if present (idempotent re-runs)
db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(SESSION_ID);

db.prepare(
  `INSERT INTO chat_sessions (id, title, messages, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(
  SESSION_ID,
  "Investigate Checkout Latency Spike",
  JSON.stringify(messages),
  "idle",
  NOW - 300,
  NOW - 290
);

// Agent runs
const agentRuns = [
  {
    id: randomUUID(),
    agent_type: "title",
    model: "gemini-3.1-flash-lite-preview",
    input_tokens: 58,
    output_tokens: 6,
  },
  {
    id: randomUUID(),
    agent_type: "chat",
    model: "gemini-3-flash-preview",
    input_tokens: 18420,
    output_tokens: 215,
  },
  {
    id: randomUUID(),
    agent_type: "memory",
    model: "gemini-3.1-flash-lite-preview",
    input_tokens: 3920,
    output_tokens: 4,
  },
];

const insertRun = db.prepare(
  `INSERT INTO agent_runs (id, session_id, agent_type, model, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, cache_write_tokens, duration_ms, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?)`
);

for (const run of agentRuns) {
  insertRun.run(
    run.id,
    SESSION_ID,
    run.agent_type,
    run.model,
    run.input_tokens,
    run.output_tokens,
    NOW - 295
  );
}

// Memory operations
const insertMemOp = db.prepare(
  `INSERT INTO memory_operations (session_id, operation, note, created_at)
   VALUES (?, ?, ?, ?)`
);
insertMemOp.run(SESSION_ID, "started", null, NOW - 294);
insertMemOp.run(SESSION_ID, "completed", null, NOW - 293);

db.close();

console.log(`Demo session inserted: ${SESSION_ID}`);
console.log(`Open http://localhost:5173/debug/${SESSION_ID} to view it.`);

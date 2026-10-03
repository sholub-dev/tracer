/**
 * Seeds a fictional demo workspace into the Tracer database for README
 * screenshots: one investigation with charts, a few ordinary sessions, three
 * New Relic monitors with firings, two monitor-triggered investigations and a
 * New Relic provider config with fake credentials. All data is fictional.
 *
 * The database is encrypted, so the key must be supplied. Start the server once
 * first (it creates the schema), then seed, then restart the server so it loads
 * the provider config:
 *
 *   TRACER_HOME=<dir> TRACER_DB_KEY=<64 hex chars> node scripts/seed-demo.mjs
 *
 * Use the same TRACER_HOME and TRACER_DB_KEY as the server. The monitor charts
 * need a fake api.newrelic.com responder in the server process; without one the
 * cards show an error.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// The driver lives in the server package; the repo root does not depend on it.
const requireFromServer = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../packages/server/package.json"));
const Database = requireFromServer("better-sqlite3-multiple-ciphers");

const keyHex = process.env.TRACER_DB_KEY?.trim();
if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) {
  console.error("Set TRACER_DB_KEY to the 64 hex character key of the database to seed (the same value the server uses).");
  process.exit(1);
}

const tracerHome = process.env.TRACER_HOME || join(homedir(), ".tracer");
const dbPath = join(tracerHome, "data", "tracer.db");
const db = new Database(dbPath, { fileMustExist: true });
db.pragma("cipher='sqlcipher'");
db.pragma(`key="x'${keyHex.toLowerCase()}'"`);
db.pragma("busy_timeout = 5000");

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

const HOUR = 3600;
const DAY = 24 * HOUR;

// --- More sessions, so the sidebar looks used ---

const insertSession = db.prepare(
  `INSERT INTO chat_sessions (id, title, messages, status, kind, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

function simpleChat(question, answer) {
  return [
    { id: randomUUID(), role: "user", parts: [{ type: "text", text: question }] },
    { id: "", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: answer, state: "done" }] },
  ];
}

const ordinarySessions = [
  {
    id: "demo-payment-502s", title: "Payment gateway 502s after deploy", age: 2 * HOUR,
    q: "Payment requests started failing with 502 right after the 14:10 deploy. What changed?",
    a: "The 502s start at **14:12**, two minutes after the `payments-api` rollout, and come only from pods on the new image.\n\n- Upstream timeout to the gateway: 4s on the new build, 10s before\n- 502 rate peaked at 6.1% and fell to 0.2% after the rollback at 14:31\n\nThe new build lowered the gateway client timeout. Restore the old value before the next rollout.",
  },
  {
    id: "demo-search-lag-eu", title: "Search index lag in EU", age: 5 * HOUR,
    q: "Search results in the EU region look stale. How far behind is the index?",
    a: "The EU index lags by **11 minutes** against 40 seconds in the US region.\n\nThe indexer consumer group in `eu-west` restarted at 09:02 and replays a backlog of about 38,000 documents. The lag shrinks by roughly one minute every three minutes.",
  },
  {
    id: "demo-signups-tuesday", title: "Why did signups drop on Tuesday?", age: DAY + 3 * HOUR,
    q: "Why did signups drop on Tuesday?",
    a: "Signups fell **31%** between 10:00 and 16:00 on Tuesday.\n\nThe drop matches a rise in `POST /signup` validation errors from the email verification step. The verification provider returned slow responses in that window, and the form timed out after 5 seconds.",
  },
  {
    id: "demo-inventory-sync", title: "Slow inventory sync job", age: 2 * DAY + 6 * HOUR,
    q: "The nightly inventory sync now takes 50 minutes instead of 15. Where does the time go?",
    a: "Most of the extra time is in one query: `SELECT ... FROM stock_levels WHERE warehouse_id = ?` runs once per SKU.\n\nThe job issues 41,000 of these calls in sequence. Batch them by warehouse to cut the run time to about 12 minutes.",
  },
  {
    id: "demo-mobile-crashes", title: "Mobile crash rate on 4.12", age: 4 * DAY + 2 * HOUR,
    q: "Is the crash rate higher on app version 4.12 than on 4.11?",
    a: "Yes. The crash-free session rate is **98.1%** on 4.12 and **99.6%** on 4.11.\n\nOver 80% of the new crashes come from one stack trace in the image cache on devices with 3 GB of memory or less.",
  },
  {
    id: "demo-redis-memory", title: "Redis memory growth in cart service", age: 9 * DAY + 4 * HOUR,
    q: "Redis memory in the cart service grows by 2 GB per day. Is this a leak?",
    a: "It is not a leak. Cart keys expire after 30 days, and the daily growth matches the rise in abandoned carts since the spring campaign.\n\nSet the expiry to 7 days to hold memory near 6 GB.",
  },
];

for (const s of ordinarySessions) {
  db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(s.id);
  insertSession.run(s.id, s.title, JSON.stringify(simpleChat(s.q, s.a)), "idle", null, NOW - s.age - 600, NOW - s.age);
}

// --- Monitors ---

const insertMonitor = db.prepare(
  `INSERT INTO monitors (id, name, provider, query, chart_query, condition, frequency_seconds, enabled, last_checked_at, last_status, sort_order, alert_enabled, created_at, updated_at)
   VALUES (?, ?, 'newrelic', ?, NULL, ?, ?, 1, ?, 'ok', ?, 1, ?, ?)`
);
const monitorDefs = [
  {
    id: "demo-mon-checkout-5xx", name: "Checkout 5xx errors",
    query: "SELECT count(*) FROM Transaction WHERE appName = 'checkout-service' AND httpResponseCode LIKE '5%' SINCE {{SINCE}} UNTIL {{UNTIL}}",
    condition: "> 30", freq: 300,
  },
  {
    id: "demo-mon-payment-timeouts", name: "Payment gateway timeouts",
    query: "SELECT count(*) FROM TransactionError WHERE appName = 'payments-api' AND error.class = 'GatewayTimeoutError' SINCE {{SINCE}} UNTIL {{UNTIL}}",
    condition: "> 25", freq: 300,
  },
  {
    id: "demo-mon-search-slow", name: "Slow search queries",
    query: "SELECT count(*) FROM Transaction WHERE appName = 'search-service' AND duration > 2 SINCE {{SINCE}} UNTIL {{UNTIL}}",
    condition: "> 150", freq: 300,
  },
];
db.prepare("DELETE FROM monitors WHERE id LIKE 'demo-mon-%'").run(); // cascades to triggers and issues
monitorDefs.forEach((m, i) =>
  insertMonitor.run(m.id, m.name, m.query, m.condition, m.freq, NOW - 120, i, NOW - 14 * DAY, NOW - 14 * DAY));

// --- Monitor-triggered investigations ---

function nrqlPart(id, query, results, analysis) {
  return {
    type: "tool-execute_nrql", toolCallId: id, state: "output-available", input: { query },
    output: { parts: [{ type: "query", query, results }], analysis },
  };
}

function alertSession({ id, title, firedAt, status, monitorQuery, series, text, summary }) {
  const messages = [
    {
      id: randomUUID(), role: "user",
      parts: [{ type: "text", text: `Monitor "Payment gateway timeouts" fired: ${summary.value} events in the last 5 minutes (condition > 25).\n\nQuery: ${monitorQuery}` }],
    },
    {
      id: "", role: "assistant",
      parts: [
        { type: "step-start" },
        nrqlPart(`${id}-q1`, "SELECT count(*) FROM TransactionError WHERE appName = 'payments-api' AND error.class = 'GatewayTimeoutError' SINCE 90 minutes ago TIMESERIES 5 minutes", series,
          series.filter((_, i) => i % 3 === 0).map((d) => `${new Date(d.beginTimeSeconds * 1000).toISOString().slice(11, 16)}: ${d.count}`).join("\n")),
        { type: "step-start" },
        { type: "text", text, state: "done" },
        {
          type: "tool-report_alert_summary", toolCallId: `${id}-s1`, state: "output-available",
          input: summary.input, output: { recorded: true },
        },
      ],
      usage: { model: "gemini-3-flash-preview", inputTokens: 21300, outputTokens: 402, reasoningTokens: 0, cachedInputTokens: 8100, cacheWriteTokens: 0 },
    },
  ];
  db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  insertSession.run(id, title, JSON.stringify(messages), status, "monitor", firedAt, firedAt + 180);
}

function bumpSeries(endSec, peakAt, peak) {
  const out = [];
  for (let i = 0; i < 18; i++) {
    const begin = endSec - (18 - i) * 300;
    const d = i - peakAt;
    const bump = d >= 0 && d < 5 ? Math.round(peak * [0.55, 1, 0.8, 0.4, 0.15][d]) : 0;
    out.push({ beginTimeSeconds: begin, endTimeSeconds: begin + 300, count: 3 + ((i * 7) % 5) + bump });
  }
  return out;
}

const timeoutQuery = monitorDefs[1].query;
const FIRST = NOW - 22 * HOUR;
const LATEST = NOW - 90 * 60;

alertSession({
  id: "demo-alert-gateway-1", title: "Payment gateway timeouts", firedAt: FIRST, status: "idle", monitorQuery: timeoutQuery,
  series: bumpSeries(FIRST, 11, 38),
  text: "**38 `GatewayTimeoutError` events** hit `payments-api` between 02:10 and 02:25, then stopped.\n\nAll of them came from calls to the card processor's EU endpoint. Checkout latency rose in the same window, and recovered without a deploy or config change. The cause is on the processor side; the data shows no change on our side.",
  summary: {
    value: 38,
    input: {
      severity: "medium",
      tldr: "Card payments timed out for 15 minutes at night, 38 failures in total.",
      rootCause: "The card processor's EU endpoint answered slowly between 02:10 and 02:25. Calls from payments-api exceeded the 4 s client timeout. Cause on the processor side not confirmed.",
      policy: "Payment gateway timeouts > 25 in 5 minutes",
      started: "02:10 UTC",
      status: "stopped (last error at 02:25 UTC)",
      issues: [{ service: "payments-api", endpoint: "/payments/{id}/authorize", errors: "38 × GatewayTimeoutError (1.9%)", userImpact: "Card payment failed and the customer retried", journeyStep: "Payment" }],
      seenBefore: "no",
    },
  },
});

alertSession({
  id: "demo-alert-gateway-2", title: "Payment gateway timeouts, again", firedAt: LATEST, status: "done", monitorQuery: timeoutQuery,
  series: bumpSeries(LATEST, 10, 64),
  text: "**64 `GatewayTimeoutError` events** hit `payments-api` since 13:55. The first minute of errors follows the 13:52 rollout of `payments-api` 2.41.\n\nThe new build lowered the gateway client timeout from 10 s to 4 s. Requests that took 4 to 10 s used to succeed; now they fail. The error rate is still above the threshold.",
  summary: {
    value: 64,
    input: {
      severity: "high",
      tldr: "Card payments fail at 3.2% since the 13:52 rollout, 64 failures in 10 minutes.",
      rootCause: "payments-api 2.41 lowered the gateway client timeout from 10 s to 4 s. Slow but valid authorizations now time out. Latency of the gateway did not change.",
      policy: "Payment gateway timeouts > 25 in 5 minutes",
      started: "13:55 UTC",
      status: "ongoing (errors in the latest minutes up to now)",
      issues: [{ service: "payments-api", endpoint: "/payments/{id}/authorize", errors: "64 × GatewayTimeoutError (3.2%)", userImpact: "Card payment failed with an error page", journeyStep: "Payment" }],
      seenBefore: "yes, 22 hours ago; that time the cause was the processor, not a rollout",
    },
  },
});

const insertTrigger = db.prepare(
  `INSERT INTO monitor_triggers (id, monitor_id, triggered_at, value, window_start, window_end, status, groups, session_id, reported)
   VALUES (?, ?, ?, ?, ?, ?, 'investigating', ?, ?, 'done')`
);
for (const [at, value, sessionId] of [[FIRST, 38, "demo-alert-gateway-1"], [LATEST, 64, "demo-alert-gateway-2"]]) {
  insertTrigger.run(randomUUID(), "demo-mon-payment-timeouts", at, value, at - 300, at,
    JSON.stringify([{ key: "", count: value, sessionId, repeat: false }]), sessionId);
}

// --- New Relic provider with fake credentials ---

db.prepare(
  `INSERT INTO provider_configs (type, config) VALUES ('newrelic', ?)
   ON CONFLICT(type) DO UPDATE SET config = excluded.config`
).run(JSON.stringify({ apiKey: "NRAK-DEMO0000000000000000000000", accountId: "1234567" }));

db.close();

console.log(`Demo data inserted: ${SESSION_ID}, ${ordinarySessions.length} sessions, ${monitorDefs.length} monitors, 2 alert sessions.`);
console.log("Restart the server so it loads the New Relic config, then open /debug/" + SESSION_ID);

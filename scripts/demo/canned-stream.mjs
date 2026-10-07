// Runs inside the browser page (serialized by Playwright, so it must stay
// self-contained). Replaces fetch for POST /api/chat with a paced UI message
// stream in the wire format the server emits, so no LLM key is needed.
export function installFakeChat() {
  const realFetch = window.fetch.bind(window);
  const START = Math.floor(Date.now() / 1000) - 3600;
  const series = (fn) => Array.from({ length: 60 }, (_, i) => ({ beginTimeSeconds: START + i * 60, endTimeSeconds: START + (i + 1) * 60, ...fn(i) }));
  // Deterministic noise, so every run draws the same chart.
  const noise = (i, k) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
  const latency = series((i) => {
    let v = 190 + Math.round(noise(i, 1) * 30);
    if (i >= 20 && i <= 22) v = 350 + Math.round(noise(i, 2) * 100);
    if (i >= 23 && i <= 30) v = 620 + Math.round(noise(i, 3) * 230);
    if (i >= 31 && i <= 34) v = 380 + Math.round(noise(i, 4) * 120);
    return { average: v };
  });
  const errors = series((i) => {
    let v = 2 + Math.round(noise(i, 5) * 6);
    if (i >= 22 && i <= 31) v = 40 + Math.round(noise(i, 6) * 50);
    if (i >= 32 && i <= 34) v = 15 + Math.round(noise(i, 7) * 10);
    return { count: v };
  });
  const Q1 = "SELECT average(duration) FROM Transaction WHERE name = 'WebTransaction/Controller/checkout' SINCE 1 hour ago TIMESERIES";
  const Q2 = "SELECT count(*) FROM TransactionError WHERE transactionName = 'WebTransaction/Controller/checkout' SINCE 1 hour ago TIMESERIES";
  const FINDING = { kind: "root_cause", headline: "Payment gateway connection pool exhausted", details: "Checkout p95 latency rose from about 210 ms to 810 ms for about ten minutes, and checkout errors rose from 2-8 to 40-90 per minute in the same window. During that window the payment gateway connection pool was at 50 of 50 connections, so checkout requests waited for a free connection.", points: ["Connection pool at 50 of 50 in use during the spike", "Checkout p95 rose from 210 ms to 810 ms", "Error rate on /checkout climbed from 0.2% to 9%"], confidence: "likely", toConfirm: "Gateway connection pool metrics for the spike window" };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.endsWith("/api/chat")) return realFetch(input, init);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        const send = (o) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        const text = async (id, s, step = 22) => {
          send({ type: "text-start", id });
          for (const w of s.match(/\S+\s*|\n+/g)) { send({ type: "text-delta", id, delta: w }); await sleep(step); }
          send({ type: "text-end", id });
        };
        const tool = async (id, toolName, input, output, runMs) => {
          send({ type: "tool-input-available", toolCallId: id, toolName, input });
          await sleep(runMs);
          send({ type: "tool-output-available", toolCallId: id, output });
        };
        await sleep(900);
        send({ type: "start-step" });
        await text("t1", "I will start with the checkout latency over the last hour.\n\n");
        await tool("tc1", "execute_nrql", { query: Q1, title: "Checkout p95 latency" }, { parts: [{ type: "query", query: Q1, results: latency }], analysis: "" }, 1600);
        send({ type: "finish-step" });
        send({ type: "start-step" });
        await text("t2", "Latency jumped well above the baseline. I will check the error count for the same window.\n\n");
        await tool("tc2", "execute_nrql", { query: Q2, title: "Checkout errors per minute" }, { parts: [{ type: "query", query: Q2, results: errors }], analysis: "" }, 1500);
        send({ type: "finish-step" });
        send({ type: "start-step" });
        await tool("tc3", "begin_analysis", {}, { status: "Analysis mode active. Follow the analysis rules from your system prompt." }, 500);
        send({ type: "finish-step" });
        send({ type: "start-step" });
        await tool("tc4", "report_finding", FINDING, { recorded: true }, 400);
        send({ type: "finish-step" });
        send({ type: "start-step" });
        await text("t3", "Latency shows the spike behind the first point.\n\n");
        await tool("tc5", "execute_nrql", { query: Q1, title: "Checkout p95 latency" }, { parts: [{ type: "query", query: Q1, results: latency }], analysis: "" }, 1500);
        send({ type: "finish-step" });
        send({ type: "start-step" });
        await text("t4", "Errors rise in the same window.\n\n");
        await tool("tc6", "execute_nrql", { query: Q2, title: "Checkout errors per minute" }, { parts: [{ type: "query", query: Q2, results: errors }], analysis: "" }, 1500);
        send({ type: "finish-step" });
        send({ type: "finish" });
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
  };
}

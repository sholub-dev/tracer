// Dry run of a monitor firing: shows the Slack message Tracer would post. Nothing is posted and nothing is written to
// New Relic or to the app database. Usage (from packages/server):
//   npx tsx ../../scripts/slack-dryrun.mts <scenarios.json> <outDir>
// scenarios.json: [{ id, monitor: { name, provider: "newrelic", query, condition }, windowStart, windowEnd }] (unix seconds)
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { SESSION_KIND, substituteWindow, unixNow } from "../packages/shared/src/index.js";
import { resolveDbKey } from "../packages/server/src/db/db-key.js";
import { applyKey } from "../packages/server/src/db/db-encryption.js";
import { createNodeDb } from "../packages/server/src/db/node-db.js";
import { runSetup } from "../packages/server/src/db/setup.js";
import { chatSessions } from "../packages/server/src/db/schema.js";
import { createContext } from "../packages/server/src/trpc/context.js";
import { ProviderRegistry } from "../packages/server/src/providers/registry.js";
import { registerDefaultProviders } from "../packages/server/src/providers/register-defaults.js";
import { registerGcpProvider } from "../packages/server/src/providers/gcp/register.js";
import { evaluateGroups, extractGroups, isNoData, parseCondition } from "../packages/server/src/monitors/condition.js";
import { classifyGroups } from "../packages/server/src/monitors/repeats.js";
import { buildMessage } from "../packages/server/src/monitors/scheduler.js";
import { alertFindingFromMessages, reportAlertSummaryTool, summaryFromMessages } from "../packages/server/src/monitors/alert-summary.js";
import { monitorAlert } from "../packages/server/src/integrations/slack.js";
import { loadSessionMessages, runChatAgent } from "../packages/server/src/agents/base-agent.js";
import { buildRunOptions } from "../packages/server/src/agents/chat-run.js";
import { decodeMessages } from "../packages/server/src/lib/messages-codec.js";
import { getTimezone } from "../packages/server/src/lib/current-context.js";

// This file sits outside any package, so the native driver resolves from the server package.
const Database = createRequire(new URL("../packages/server/package.json", import.meta.url))("better-sqlite3-multiple-ciphers") as new (path: string, options?: { readonly?: boolean }) => Parameters<typeof createNodeDb>[0] & { close(): void };
type UIMessage = Parameters<typeof summaryFromMessages>[0][number];

interface Scenario {
  id: string;
  monitor: { name: string; provider: "newrelic"; query: string; condition: string };
  windowStart: number;
  windowEnd: number;
}

// Writes and side effects the dry run must never expose. A name that matches stops the run.
const BANNED = /^(post_slack_message|set_timer|ask_user|report_issue_status|dismiss_alert)$|^(ack|close|comment|dismiss)/i;
const USD_PER_M = { input: 0.75, output: 3.75, cachedFactor: 0.25 };

const [scenariosPath, outArg] = process.argv.slice(2);
if (!scenariosPath || !outArg) {
  console.error("Usage: npx tsx ../../scripts/slack-dryrun.mts <scenarios.json> <outDir>");
  process.exit(2);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

// Read-only copy of the settings the agent needs; the app database is never written.
const realHome = process.env.TRACER_HOME || join(homedir(), ".tracer");
const real = new Database(join(realHome, "data", "tracer.db"), { readonly: true });
applyKey(real, resolveDbKey(realHome, { hasEncryptedDb: true }));
const providerRows = real.prepare("SELECT * FROM provider_configs").all() as Array<Record<string, unknown>>;
const settingRows = real.prepare("SELECT * FROM app_settings").all() as Array<Record<string, unknown>>;
const memoryRows = real.prepare("SELECT * FROM tool_memories").all() as Array<Record<string, unknown>>;
real.close();

// Chat tools of the scratch run must not reach Slack or Jira, so those settings stay out of the copy.
const EXCLUDED_SETTING = /slack|jira|device_id/i;

const scratchPath = join(outDir, ".scratch.db");
for (const suffix of ["", "-wal", "-shm"]) rmSync(scratchPath + suffix, { force: true });
const scratch = new Database(scratchPath);
const { db, setupDriver } = createNodeDb(scratch);
await runSetup(setupDriver);

function copyRows(table: string, rows: Array<Record<string, unknown>>): void {
  for (const row of rows) {
    const cols = Object.keys(row);
    scratch.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
  }
}
copyRows("provider_configs", providerRows.filter((r) => !/jira|slack/i.test(String(r.type))));
copyRows("app_settings", settingRows.filter((r) => !EXCLUDED_SETTING.test(String(r.key))));
copyRows("tool_memories", memoryRows);

const providers = new ProviderRegistry();
registerDefaultProviders(providers, registerGcpProvider);
const context = createContext({ db, providers });
await providers.initializeFromDb(db);
await providers.whenLoaded();

const timeZone = await getTimezone(db);
const usageOf = (messages: UIMessage[]) => {
  let input = 0, output = 0, cached = 0;
  for (const m of messages) {
    const u = (m as { usage?: Record<string, number> }).usage;
    if (!u) continue;
    input += u.inputTokens ?? u.input ?? 0;
    output += u.outputTokens ?? u.output ?? 0;
    cached += u.cachedInputTokens ?? u.cacheReadTokens ?? u.cached ?? 0;
  }
  const cost = ((input - cached) * USD_PER_M.input + cached * USD_PER_M.input * USD_PER_M.cachedFactor + output * USD_PER_M.output) / 1e6;
  return { input, output, cached, cost };
};

let totalCost = 0;
try {
  const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8")) as Scenario[];
  for (const s of scenarios) {
    const window = { start: s.windowStart, end: s.windowEnd };
    const provider = providers.getProvider(s.monitor.provider);
    if (!provider?.connected) { console.log(`[${s.id}] provider ${s.monitor.provider} is not connected; skipped`); continue; }
    const condition = parseCondition(s.monitor.condition);
    if (!condition) { console.log(`[${s.id}] invalid condition; skipped`); continue; }

    const result = await provider.executeRawQuery(substituteWindow(s.monitor.provider, s.monitor.query, window.start, window.end));
    const extracted = extractGroups(result, s.monitor.provider);
    const evaluation = evaluateGroups(condition, extracted);
    if (isNoData(result, extracted) || !evaluation.fires) {
      console.log(`[${s.id}] does not fire (value ${evaluation.value}, condition ${s.monitor.condition}); skipped`);
      continue;
    }
    const groups = evaluation.groups.length > 0 ? evaluation.groups : [{ key: "", count: evaluation.value, additive: true }];
    const classified = await classifyGroups(db, "dry-run", groups, unixNow());

    const monitor = { id: "dry-run", name: s.monitor.name, provider: s.monitor.provider, query: s.monitor.query, condition: s.monitor.condition } as Parameters<typeof buildMessage>[0];
    const message = buildMessage(monitor, evaluation.value, window, classified, [], [], false, true);
    writeFileSync(join(outDir, `${s.id}.prompt.txt`), message);

    const sessionId = `dry-run-${s.id}-${crypto.randomUUID()}`;
    const now = unixNow();
    await db.insert(chatSessions).values({ id: sessionId, title: s.monitor.name, messages: "[]", status: "idle", kind: SESSION_KIND.MONITOR, createdAt: now, updatedAt: now }).run();
    const userMessage: UIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: message }] };
    const loaded = await loadSessionMessages(db, sessionId, userMessage);

    // Same options as a real firing (agent, prompt, model, gate); the tool set is then filtered and checked.
    const options = await buildRunOptions(context, {
      sessionId, kind: SESSION_KIND.MONITOR,
      extras: { report_alert_summary: reportAlertSummaryTool({ slack: true }) },
      onComplete: () => {},
    });
    const collectTools: typeof options.collectTools = async (writer) => {
      const collected = await options.collectTools!(writer);
      const tools = Object.fromEntries(Object.entries(collected.tools ?? {}).filter(([name]) => !BANNED.test(name)));
      const names = Object.keys(tools);
      console.log(`[${s.id}] tools (${names.length}): ${names.join(", ")}`);
      return { ...collected, tools, afterComplete: undefined };
    };

    const started = await runChatAgent({
      sessionId, messages: loaded.messages, summary: loaded.summary, summaryUpTo: loaded.summaryUpTo, context,
      ...options, collectTools, onFailed: (error) => console.error(`[${s.id}] run failed: ${error}`),
    });
    if ("error" in started) { console.error(`[${s.id}] could not start: ${started.error}`); continue; }
    await started.stream.pipeTo(new WritableStream());
    // The stream ends when the broadcaster finishes, which is after the final save.
    const row = scratch.prepare("SELECT messages FROM chat_sessions WHERE id = ?").get(sessionId) as { messages: string } | undefined;
    const messages = decodeMessages(row?.messages ?? "[]");

    const summary = summaryFromMessages(messages);
    const finding = alertFindingFromMessages(messages);
    const payload = monitorAlert({
      name: s.monitor.name, triggeredAt: s.windowEnd, summary, finding, timeZone, mentions: undefined, ping: summary?.notify === true,
    });
    const { text, blocks } = payload as { text: string; blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ text?: string }> }> };
    const lines: string[] = [];
    for (const b of blocks) {
      if (b.text?.text) lines.push(b.text.text);
      for (const e of b.elements ?? []) if (e.text) lines.push(e.text);
    }
    writeFileSync(join(outDir, `${s.id}.slack.txt`), `${text}\n\n${lines.join("\n\n")}\n`);
    writeFileSync(join(outDir, `${s.id}.payload.json`), JSON.stringify(payload, null, 2));
    writeFileSync(join(outDir, `${s.id}.messages.json`), JSON.stringify(messages, null, 2));
    const usage = usageOf(messages);
    totalCost += usage.cost;
    console.log(`[${s.id}] tokens in ${usage.input} (cached ${usage.cached}) out ${usage.output}; cost $${usage.cost.toFixed(4)}`);
  }
  console.log(`total cost $${totalCost.toFixed(4)}`);
} finally {
  scratch.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(scratchPath + suffix, { force: true });
  for (const p of providers.getAllProviders()) await p.dispose().catch(() => {});
  process.exit(0);
}

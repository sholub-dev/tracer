import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";
import { createNodeDb } from "../db/node-db.js";
import { runSetup } from "../db/setup.js";
import { chatSessions, monitors, monitorTriggers } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { UNIFIED_SCOPE } from "@tracer-sh/shared";
import type { Context } from "../trpc/context.js";
import { buildRunOptions, chatRunOptions } from "./chat-run.js";
import { personTurn, settleInterruptedRuns } from "./resume.js";
import { writeSlackConfig } from "../integrations/slack.js";
import { writeJiraConfig } from "../integrations/jira/config.js";
import { isWakeupTurn } from "../monitors/triage.js";

async function env() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const { db, setupDriver } = createNodeDb(sqlite);
  await runSetup(setupDriver);
  const provider = {
    name: "newrelic", type: "newrelic", connected: true,
    getChatTools: () => ({ tools: { close_nr_issue: { id: "unscoped" }, query: {} }, promptFragments: [] }),
  };
  const providers = { whenLoaded: async () => {}, reconnectDisconnected: async () => {}, getAllProviders: () => [provider], getProvider: () => provider };
  const context = { db, providers, activeStreams: new Map() } as unknown as Context;
  await db.insert(monitors).values({ id: "m1", name: "M", query: "q", condition: "> 0" }).run();
  await db.insert(chatSessions).values({ id: "s1", title: "t", messages: "[]", kind: "monitor" }).run();
  await db.insert(monitorTriggers).values({ id: "t1", monitorId: "m1", triggeredAt: 1, value: 1, windowStart: 0, windowEnd: 0, status: "investigating", groups: "[]", sessionId: "s1" }).run();
  return { db, context };
}

const collect = async (options: Awaited<ReturnType<typeof buildRunOptions>>) =>
  (await options.collectTools({} as never)).tools as Record<string, unknown>;

test("user chat and unattended runs use their own retry delays", async () => {
  const { context } = await env();
  assert.equal((await buildRunOptions(context, { sessionId: "s1", interactive: true })).retryDelaysMs, CONFIG.chatRetryDelaysMs);
  assert.equal((await buildRunOptions(context, { sessionId: "s1" })).retryDelaysMs, CONFIG.agentRetryDelaysMs);
  assert.equal((await chatRunOptions(context, "s1")).retryDelaysMs, CONFIG.chatRetryDelaysMs);
});

test("only a monitor run must end with a finding card", async () => {
  const { context } = await env();
  assert.equal((await buildRunOptions(context, { sessionId: "s1", kind: "monitor", scope: UNIFIED_SCOPE })).requireFinding, true);
  assert.equal((await buildRunOptions(context, { sessionId: "s1", scope: UNIFIED_SCOPE, interactive: true })).requireFinding, false);
  assert.equal((await chatRunOptions(context, "none")).requireFinding, false);
});

test("a chat turn gets every tool; an unattended run of a monitor session gets no write tool of its own", async () => {
  const { db, context } = await env();
  await writeSlackConfig(db, { webhookUrl: "https://hooks.slack.com/services/T/B/x" });
  await writeJiraConfig(db, { domain: "example", email: "a@b.c", apiToken: "t" });
  const names = async (options: Awaited<ReturnType<typeof buildRunOptions>>) => Object.keys(await collect(options)).sort();
  const session = ["ask_user", "report_finding", "set_timer"];

  const chat = await names(await buildRunOptions(context, { sessionId: "c1", scope: UNIFIED_SCOPE, interactive: true }));
  assert.deepEqual(chat, ["add_jira_comment", "close_nr_issue", "get_jira_issue", "post_slack_message", "query", ...session].sort());

  // A firing or a wake-up: the scheduler supplies the tools of the run.
  const scoped = { close_nr_issue: { id: "scoped" }, report_alert_summary: {} };
  const firing = await collect(await buildRunOptions(context, { sessionId: "s1", kind: "monitor", scope: UNIFIED_SCOPE, extras: scoped, onComplete: () => {} }));
  assert.deepEqual(Object.keys(firing).sort(), ["close_nr_issue", "get_jira_issue", "query", "read_past_session", "report_alert_summary", ...session].sort());
  assert.deepEqual(firing.close_nr_issue, { id: "scoped" }, "only the close tool limited to the firing's issues");

  const wakeup = await names(await buildRunOptions(context, { sessionId: "s1", kind: "monitor", scope: UNIFIED_SCOPE, extras: { report_alert_summary: {} }, onComplete: () => {} }));
  assert.deepEqual(wakeup, ["get_jira_issue", "query", "read_past_session", "report_alert_summary", ...session].sort());

  // A re-run of a firing that never reported, started from the chat.
  const rerun = await names(await chatRunOptions(context, "s1"));
  assert.deepEqual(rerun, ["get_jira_issue", "query", "read_past_session", "report_alert_summary", ...session].sort());

  // A person's later turn in the session of a reported firing keeps every tool.
  await db.update(monitorTriggers).set({ reported: "done" }).run();
  const later = await names(await chatRunOptions(context, "s1"));
  assert.deepEqual(later, [...chat, "read_past_session"].sort());
});

test("the prompt of a monitor run names no tool the run lacks", async () => {
  const { db, context } = await env();
  await writeSlackConfig(db, { webhookUrl: "https://hooks.slack.com/services/T/B/x" });
  await writeJiraConfig(db, { domain: "example", email: "a@b.c", apiToken: "t" });
  const prompt = async (options: Awaited<ReturnType<typeof buildRunOptions>>) => {
    const collected = await options.collectTools({} as never);
    return [collected.systemPrompt ?? "", ...(collected.promptFragments ?? [])].join("\n");
  };
  const monitor = await prompt(await buildRunOptions(context, { sessionId: "s1", kind: "monitor", scope: UNIFIED_SCOPE }));
  assert.doesNotMatch(monitor, /post_slack_message|add_jira_comment|post comments/);
  assert.match(monitor, /get_jira_issue/);
  const chat = await prompt(await buildRunOptions(context, { sessionId: "c1", scope: UNIFIED_SCOPE, interactive: true }));
  assert.match(chat, /post_slack_message/);
  assert.match(chat, /add_jira_comment/);
});

test("a monitor run gets its extras and its completion hook, also when resumed", async () => {
  const { context } = await env();
  const done: unknown[] = [];
  const extras = { close_nr_issue: { id: "scoped" }, report_alert_summary: {} };
  const options = await buildRunOptions(context, { sessionId: "s1", kind: "monitor", scope: UNIFIED_SCOPE, extras, onComplete: (o) => done.push(o) });
  const collected = await options.collectTools({} as never);
  assert.deepEqual((collected.tools as Record<string, unknown>).close_nr_issue, { id: "scoped" });
  collected.afterComplete?.({} as never);
  options.onFailed?.("boom");
  assert.deepEqual(done, [{}, { error: "boom" }]);
});

test("an unreported firing gets its report tool and hook on a chat turn", async () => {
  const { context } = await env();
  const tools = await collect(await chatRunOptions(context, "s1"));
  assert.ok(tools.report_alert_summary);
  assert.ok((await chatRunOptions(context, "s1")).onFailed);
});

test("a restart returns the kind of a resumable run and lists ended monitor sessions", async () => {
  const { db } = await env();
  const old = Math.floor(Date.now() / 1000) - CONFIG.chatResumeMaxAgeSec - 60;
  await db.insert(chatSessions).values({ id: "fresh", title: "t", messages: "[]", kind: "monitor", status: "streaming", runScope: UNIFIED_SCOPE }).run();
  await db.insert(chatSessions).values({ id: "old", title: "t", messages: "[]", kind: "monitor", status: "streaming", runScope: UNIFIED_SCOPE, updatedAt: old }).run();
  const { interrupted: runs, settled } = await settleInterruptedRuns(db);
  assert.deepEqual(runs, [{ id: "fresh", scope: UNIFIED_SCOPE, kind: "monitor" }]);
  assert.deepEqual(settled, ["old"]);
});

test("a resumed turn of a monitor session is a person's own only when neither the firing nor a wake-up began it", () => {
  const user = (t: string) => ({ id: "", role: "user" as const, parts: [{ type: "text" as const, text: t }] });
  const firing = user('Monitor "Errors" triggered.\n\n<alert_data>');
  const reply = { id: "", role: "assistant" as const, parts: [] };
  assert.equal(personTurn("monitor", [firing, reply]), false);
  assert.equal(personTurn("monitor", [firing, reply, user("Follow-up timer (set 10:00): scheduled re-check")]), false);
  assert.equal(personTurn("monitor", [firing, reply, user("why did it fire?"), reply]), true);
  assert.equal(personTurn("monitor", [firing, reply, user("why did it fire?"), { ...user("and now?"), metadata: { steered: true } }]), true);
  assert.equal(personTurn("chat", [user("hi")]), false);
  assert.equal(personTurn(null, [user("hi")]), false);
});

test("a wake-up message is told from a chat turn", () => {
  const user = (t: string) => ({ id: "", role: "user" as const, parts: [{ type: "text" as const, text: t }] });
  assert.equal(isWakeupTurn([user("hi"), user("Follow-up timer (set 10:00): check. Check it now.")]), true);
  assert.equal(isWakeupTurn([user("Follow-up timer (set 10:00): check."), user("thanks")]), false);
});

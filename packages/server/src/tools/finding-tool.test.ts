import { test } from "node:test";
import assert from "node:assert/strict";
import { findingFromMessages, UNCHECKED_NOTE, findingMarkdown } from "@tracer-sh/shared";
import { WRITE_TOOLS } from "./tool-gate.js";
import { withSessionTools } from "./chat-tools.js";
import { reportFindingTool } from "./finding-tool.js";
import type { Db } from "../db/driver.js";

const valid = {
  kind: "root_cause" as const, verdict: "problem" as const, title: "Pool exhausted by a retry storm", answer: "The pool ran out of connections.",
  explanation: [{ statement: "Pool usage hit 50 of 50 connections.", source: "Pool usage" }, { statement: "Retries rose to 56.3 per second.", source: "Retry rate" }],
  confidence: "likely" as const, unknown: "Who sent the retries.",
};
const call = (input: unknown, state = "output-available") => ({ type: "tool-report_finding", toolCallId: "x", state, input, output: { recorded: true } });
const msgs = (...parts: unknown[]) => [{ parts: parts as { type: string }[] }];

test("findingFromMessages takes the last successful valid call", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ ...valid, title: "later" }))), { ...valid, title: "later" });
});

test("a card the check sent back is never the answer", () => {
  const rejected = { ...call({ ...valid, title: "rejected" }), output: { recorded: false, problems: "x", next: "y" } };
  assert.deepEqual(findingFromMessages(msgs(call(valid), rejected)), valid);
  assert.equal(findingFromMessages(msgs(rejected)), null);
});

const query = (id: string, title: string, result: string, output: unknown = { type: "text" as const, value: `<tool_result>\n${result}\n</tool_result>` }) => [
  { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, toolName: "execute_nrql", input: { query: "SELECT 1", title } }] },
  { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: id, toolName: "execute_nrql", output }] },
];
const sentBack = (id = "p") => ({
  role: "tool" as const,
  content: [{ type: "tool-result" as const, toolCallId: id, toolName: "report_finding", output: { type: "json" as const, value: { recorded: false, problems: "x", next: "n" } } }],
});
const turn = () => [
  { role: "user" as const, content: "why?" },
  ...query("a", "Pool usage", "used,max\n50,50"),
  ...query("b", "Retry rate", "perSecond\n56.33"),
];
const ask = (card: unknown, messages: unknown[], originals = new Map<string, string>(), from = 0) =>
  (reportFindingTool(originals, () => from) as any).execute(card, { messages, toolCallId: "t" });

test("a card whose sources and numbers are in this turn is recorded", async () => {
  assert.deepEqual(await ask(valid, turn()), { recorded: true });
});

test("a source that is not the title of a successful query is sent back", async () => {
  const card = { ...valid, explanation: [{ statement: "Pool usage hit 50 of 50.", source: "Pool stats" }, valid.explanation[1]] };
  const out = await ask(card, turn());
  assert.equal(out.recorded, false);
  assert.match(out.problems, /Statement 1 .*"Pool stats" is not the title/);
  const failed = [{ role: "user" as const, content: "why?" }, ...query("a", "Pool usage", "boom", { type: "text", value: "Error: timeout" }), ...query("b", "Retry rate", "56.33")];
  assert.match((await ask(valid, failed)).problems, /"Pool usage" is not the title/);
});

test("a number missing from the cited result is sent back", async () => {
  const card = { ...valid, explanation: [valid.explanation[0], { statement: "Retries rose to 71.9 per second, up 40%.", source: "Retry rate" }] };
  const out = await ask(card, turn());
  assert.equal(out.recorded, false);
  assert.match(out.problems, /Statement 2 .*71\.9 is not in the result of "Retry rate"/);
  assert.match(out.problems, /40 is not in/);
  assert.equal(out.next.length > 0, true);
});

test("a number from another query's result does not count", async () => {
  const card = { ...valid, explanation: [{ statement: "Retries rose to 56.3 per second.", source: "Pool usage" }] };
  assert.equal((await ask(card, turn())).recorded, false);
});

test("small numbers, times, dates, code spans and names with letters are not checked", async () => {
  const statement = "At 08:14 on 2026-10-25 `PoolTimeout42` hit p95 and 5xx on v2 with 7 hosts; 1,200 of 99%.";
  const messages = [{ role: "user" as const, content: "why?" }, ...query("a", "Pool usage", "1200,99")];
  const card = { ...valid, explanation: [{ statement, source: "Pool usage" }] };
  assert.deepEqual(await ask(card, messages), { recorded: true });
  assert.equal((await ask({ ...card, explanation: [{ statement: "1,300 hosts", source: "Pool usage" }] }, messages)).recorded, false);
});

test("a masked result is checked against the stored original", async () => {
  const stub = "Cut from the context to save space. Call read_result with id \"b\" to read it whole. Retry rate: 900 lines. First lines:\nperSecond";
  const messages = [{ role: "user" as const, content: "why?" }, ...query("a", "Pool usage", "50,50"), ...query("b", "Retry rate", "", { type: "text", value: stub })];
  assert.equal((await ask(valid, messages)).recorded, false);
  assert.deepEqual(await ask(valid, messages, new Map([["b", "perSecond\n10\n56.33\n12"]])), { recorded: true });
});

test("the third card of a turn is recorded, marked unchecked when it still fails, and an earlier turn does not count", async () => {
  const bad = { ...valid, explanation: [{ statement: "Nothing here.", source: "No such query" }] };
  assert.equal((await ask(bad, turn())).recorded, false);
  assert.equal((await ask(bad, [...turn(), sentBack()])).recorded, false);
  const third = await ask(bad, [...turn(), sentBack(), sentBack("q")]);
  assert.equal(third.recorded, true);
  assert.match(third.unchecked, /No such query/);
  const earlier = [sentBack(), sentBack("q"), ...turn()];
  assert.equal((await ask(bad, earlier, new Map(), 2)).recorded, false);
  assert.equal((await ask(bad, earlier, new Map(), 0)).recorded, true);
});

test("a query tool with no title or a write tool is not a source", async () => {
  const write = [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "w", toolName: "close_nr_issue", input: { title: "Pool usage" } }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "w", toolName: "close_nr_issue", output: { type: "text", value: "50 50" } }] },
  ];
  const card = { ...valid, explanation: [valid.explanation[0]] };
  assert.equal((await ask(card, [{ role: "user" as const, content: "why?" }, ...write])).recorded, false);
});

const analysis = (output: unknown = { type: "json" as const, value: { status: "ok" } }) => [
  { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "an", toolName: "begin_analysis", input: {} }] },
  { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "an", toolName: "begin_analysis", output }] },
];
const askWith = (card: unknown, messages: unknown[]) => (reportFindingTool(new Map(), () => 0, () => true) as any).execute(card, { messages, toolCallId: "t" });

test("a root cause needs a successful begin_analysis in the turn when the tool is available", async () => {
  const out = await askWith(valid, turn());
  assert.equal(out.recorded, false);
  assert.match(out.problems, /Call begin_analysis with the ledger before the card\./);
  assert.deepEqual(await askWith(valid, [...turn(), ...analysis()]), { recorded: true });
  assert.equal((await askWith(valid, [...turn(), ...analysis({ type: "error-text", value: "x" })])).recorded, false);
  assert.equal((await askWith(valid, [...turn(), sentBack(), sentBack("q")])).recorded, true);
  assert.deepEqual(await ask(valid, turn()), { recorded: true }, "skipped when the tool is not available");
  const summary = { ...valid, kind: "summary" as const };
  assert.deepEqual(await askWith(summary, turn()), { recorded: true });
  const dismissed = [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "d", toolName: "dismiss_alert", input: { reason: "closed" } }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "d", toolName: "dismiss_alert", output: { type: "json" as const, value: { recorded: true } } }] },
  ];
  assert.deepEqual(await askWith(valid, [...turn(), ...dismissed]), { recorded: true }, "a dismissed firing needs no ledger");
});

test("a number in the answer must be in a cited result", async () => {
  const out = await ask({ ...valid, answer: "Retries hit 88.1 per second, 56.3 normally." }, turn());
  assert.equal(out.recorded, false);
  assert.match(out.problems, /answer: 88\.1 is not in the result of any cited source\./);
  assert.doesNotMatch(out.problems, /answer: 56/);
});

test("a number from the answer is not repeated in a statement", async () => {
  const card = { ...valid, answer: "The pool held 50 of 50 connections, with 1,193 retries.", explanation: [{ statement: "Pool usage hit 50 of 50 connections.", source: "Pool usage" }, valid.explanation[1]] };
  const messages = [...turn(), ...query("c", "Retry count", "retries\n1193")];
  const out = await ask(card, messages);
  assert.equal(out.recorded, false);
  assert.match(out.problems, /statement 1 repeats 50 from the answer: state each number once; keep it in the answer and give the statement a new fact\./);
  const normalized = await ask({ ...card, answer: "There were 1,193 retries.", explanation: [{ statement: "Retries reached 1193 in total.", source: "Retry count" }] }, messages);
  assert.match(normalized.problems, /statement 1 repeats 1193 from the answer/);
});

test("a number is not stated in two statements", async () => {
  const card = { ...valid, explanation: [valid.explanation[0], { statement: "Retries rose while usage held 50 connections.", source: "Pool usage" }] };
  const out = await ask(card, turn());
  assert.equal(out.recorded, false);
  assert.match(out.problems, /statements 1 and 2 both state 50: state each number once\./);
});

test("an id in any text field is sent back", async () => {
  for (const [field, text] of [["answer", "Error in 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f."], ["title", "Trace 4bf92f3577b34da6a3ce929d0e0e4736 failed"], ["unknown", "Owner of 0123456789abcdef0123"]] as const) {
    const out = await ask({ ...valid, [field]: text }, turn());
    assert.equal(out.recorded, false, field);
    assert.match(out.problems, new RegExp(`The ${field} holds an id\\. Name the service, endpoint or condition instead of the id\\.`));
  }
  const statement = { statement: "Pool held 50 of 50 for 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f.", source: "Pool usage" };
  assert.match((await ask({ ...valid, explanation: [statement] }, turn())).problems, /The statement 1 holds an id/);
  assert.deepEqual(await ask({ ...valid, answer: "Build deadbeef failed." }, turn()), { recorded: true });
});

test("an action with no system change in the turn is sent back", async () => {
  for (const action of ["", "None", "Omit action as no operational action was performed."]) {
    const out = await ask({ ...valid, action }, turn());
    assert.equal(out.recorded, false, action);
    assert.match(out.problems, /Omit action: no tool changed a system in this turn\./);
  }
  const closed = { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "c", toolName: "close_nr_issue", output: { type: "json" as const, value: { ok: true } } }] };
  assert.deepEqual(await ask({ ...valid, action: "Closed the issue" }, [...turn(), closed]), { recorded: true });
});

test("findingFromMessages reads a root cause without confidence as unverified", () => {
  const { confidence: _c, unknown: _u, ...bare } = valid;
  assert.deepEqual(findingFromMessages(msgs(call(bare))), { ...bare, confidence: "unverified" });
  assert.match(findingMarkdown(bare), /^\*\*Problem \(unverified\):\*\*/);
});

test("findingFromMessages keeps inline markdown and findingMarkdown passes it through", () => {
  const statement = "**50 of 50** connections held; `PoolTimeoutError` from 10:05.";
  const card = { ...valid, explanation: [{ statement, source: "Pool usage" }] };
  assert.equal(findingFromMessages(msgs(call(card)))?.explanation[0].statement, statement);
  assert.ok(findingMarkdown(card).includes(statement));
});

test("findingFromMessages skips invalid input and unfinished calls", () => {
  assert.deepEqual(findingFromMessages(msgs(call(valid), call({ title: "x" }), call({ ...valid, title: "z" }, "input-available"))), valid);
  const seven = ["1", "2", "3", "4", "5", "6", "7"].map((statement) => ({ statement, source: "q" }));
  assert.equal(findingFromMessages(msgs(call({ ...valid, explanation: seven }))), null);
  assert.equal(findingFromMessages([]), null);
});

test("every session gets report_finding", () => {
  assert.ok("report_finding" in withSessionTools({}, {} as Db, "s"));
  assert.ok(WRITE_TOOLS.has("report_finding"));
});

test("scoped extras override the general tool of the same name", () => {
  const provider = { execute_nrql: {}, ack_nr_issue: { id: "general" }, close_nr_issue: { id: "general" } };
  const tools = withSessionTools(provider, {} as Db, "s", { close_nr_issue: { id: "scoped" }, report_alert_summary: {} });
  assert.deepEqual(tools.close_nr_issue, { id: "scoped" });
  assert.deepEqual(tools.ack_nr_issue, { id: "general" });
  assert.deepEqual(Object.keys(tools).sort(), ["ack_nr_issue", "ask_user", "close_nr_issue", "execute_nrql", "report_alert_summary", "report_finding", "set_timer"]);
});

test("findingMarkdown renders the sections and skips empty ones", () => {
  assert.equal(
    findingMarkdown({ ...valid, action: "Closed the issue" }),
    "**Problem (likely):** Pool exhausted by a retry storm\n\nThe pool ran out of connections.\n\n**Why:**\n1. Pool usage hit 50 of 50 connections.\n2. Retries rose to 56.3 per second.\n\n**Action taken:** Closed the issue\n\n**Unknown:** Who sent the retries.\n\n**Sources:**\n- Pool usage\n- Retry rate",
  );
});

test("a summary parses, drops root-cause fields but keeps unknown, and renders as a summary", () => {
  const summary = { kind: "summary" as const, title: "", answer: "Checkout is healthy at 0.2% errors", explanation: [{ statement: "p95 is 210 ms", source: "Latency" }] };
  assert.deepEqual(findingFromMessages(msgs(call({ ...summary, confidence: "likely", verdict: "problem", unknown: "No release time" }))), { ...summary, unknown: "No release time" });
  assert.equal(findingMarkdown(summary), "**Summary:** Checkout is healthy at 0.2% errors\n\n**Details:**\n1. p95 is 210 ms\n\n**Sources:**\n- Latency");
});

test("a card saved in the old headline shape still parses", () => {
  const old = { kind: "root_cause", headline: "Pool exhausted", chain: [{ fact: "a 1", query: "Pool usage" }], gap: "Deploy history", confidence: "likely" };
  assert.deepEqual(findingFromMessages(msgs(call(old))), {
    kind: "root_cause", title: "", answer: "Pool exhausted", explanation: [{ statement: "a 1", source: "Pool usage" }], unknown: "Deploy history", confidence: "likely",
  });
});

test("a number with more than two decimals is sent back", async () => {
  const out = await ask({ ...valid, explanation: [{ statement: "Retries rose to 56.330 per second.", source: "Retry rate" }] }, turn());
  assert.equal(out.recorded, false);
  assert.match(out.problems, /writes 56\.330: round it to at most two decimals/);
});

test("the first card is sent back with the ledger challenges when no query ran after them", async () => {
  const reviewed = (challenges: string[]) => [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "ba", toolName: "begin_analysis", input: {} }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "ba", toolName: "begin_analysis", output: { type: "json" as const, value: { status: "x", challenges } } }] },
  ];
  const summary = { ...valid, kind: "summary" as const };
  const out = await ask(summary, [...turn(), ...reviewed(["Offers fell 66% and the card calls it stable.", "split.slice: 12 is not in the result"])]);
  assert.equal(out.recorded, false);
  assert.match(out.problems, /Offers fell 66%/);
  assert.doesNotMatch(out.problems, /split\.slice/);
  assert.deepEqual(await ask(summary, [...turn(), ...reviewed(["split.slice: 12 is not in the result"])]), { recorded: true });
  assert.equal((await ask(summary, [...reviewed(["Offers fell 66%."]), ...turn()])).recorded, false, "a query alone does not settle it");
  assert.deepEqual(await ask(summary, [...reviewed(["Offers fell 66%."]), ...turn(), ...reviewed([])]), { recorded: true }, "a new review without it does");
});

test("a card that calls traffic a bot is sent back unless the ledger grounds it", async () => {
  const bot = { ...valid, title: "Bot wave slowed checkout" };
  const ledger = (actor: unknown) => [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "an", toolName: "begin_analysis", input: { actor } }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "an", toolName: "begin_analysis", output: { type: "json" as const, value: { status: "ok" } } }] },
  ];
  const out = await askWith(bot, [...turn(), ...ledger({ verdict: "bot" })]);
  assert.equal(out.recorded, false);
  assert.match(out.problems, /unusual traffic from its source/);
  const part = { statement: "x", sources: ["y"] };
  assert.deepEqual(await askWith(bot, [...turn(), ...ledger({ verdict: "bot", indicator: part, holdsChange: part })]), { recorded: true });
  const ungrounded = ledger({ verdict: "bot", indicator: part, holdsChange: part });
  ((ungrounded[1].content[0] as any).output.value as { challenges?: string[] }).challenges = ["actor.indicator: 300 is not in the result of \"y\"."];
  assert.equal((await askWith(bot, [...turn(), ...ungrounded])).recorded, false, "an indicator with ungrounded numbers does not back it");
});

test("a large number without thousands separators is sent back", async () => {
  const out = await ask({ ...valid, explanation: [{ statement: "Requests reached 1102458.", source: "Retry rate" }] }, turn());
  assert.match(out.problems, /writes 1102458: write it with thousands separators \(1,102,458\)/);
});

test("a card recorded with failing checks reads as unverified with a note", () => {
  const summary = { ...valid, kind: "summary" as const };
  const f = findingFromMessages([{ parts: [{ type: "tool-report_finding", toolCallId: "x", state: "output-available", input: valid, output: { recorded: true, unchecked: "x" } } as never] }]);
  assert.equal(f?.confidence, "unverified");
  assert.equal(findingFromMessages([{ parts: [{ type: "tool-report_finding", toolCallId: "x", state: "output-available", input: summary, output: { recorded: true, unchecked: "x" } } as never] }])?.unknown, `Who sent the retries. ${UNCHECKED_NOTE}`);
});

test("the last step and the repair pass need no ledger, and style problems alone do not mark a card unchecked", async () => {
  const final = (card: unknown, messages: unknown[]) => (reportFindingTool(new Map(), () => 0, () => true, () => true) as any).execute(card, { messages, toolCallId: "t" });
  assert.deepEqual(await final(valid, turn()), { recorded: true });
  const repeated = { ...valid, answer: "The pool held 50 of 50 connections.", explanation: [{ statement: "Pool usage hit 50 connections.", source: "Pool usage" }] };
  assert.deepEqual(await ask(repeated, [...turn(), sentBack(), sentBack("q")]), { recorded: true });
});

test("an id in a code span is allowed, and a query of the same step is a source", async () => {
  assert.deepEqual(await ask({ ...valid, unknown: "Account `3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f` sent the retries." }, turn()), { recorded: true });
  const step = reportFindingTool(new Map(), () => 0, () => false, () => false, () => [{ toolName: "execute_nrql", input: { title: "Retry rate" }, text: "perSecond\n56.33" }]) as any;
  const first = [{ role: "user" as const, content: "why?" }, ...query("a", "Pool usage", "used,max\n50,50")];
  assert.deepEqual(await step.execute(valid, { messages: first, toolCallId: "t" }), { recorded: true });
});

test("an old card with no chain or points still parses", () => {
  assert.equal(findingFromMessages(msgs(call({ kind: "summary", headline: "Healthy", details: "", points: [] })))?.answer, "Healthy");
  assert.equal(findingFromMessages(msgs(call({ kind: "root_cause", headline: "Pool", confidence: "likely" })))?.answer, "Pool");
  assert.equal(findingMarkdown({ kind: "summary", title: "", answer: "Healthy", explanation: [] }), "**Summary:** Healthy");
});

test("a card sent back over a challenge and resent unchanged is sent back again, then marked unchecked", async () => {
  const summary = { ...valid, kind: "summary" as const };
  const reviewed = [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "ba", toolName: "begin_analysis", input: {} }] },
    { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "ba", toolName: "begin_analysis", output: { type: "json" as const, value: { status: "x", challenges: ["Exceptions doubled and the card calls it healthy."] } } }] },
  ];
  const resent = (card: unknown, id: string) => [{ role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, toolName: "report_finding", input: card }] }, sentBack(id)];
  assert.equal((await ask(summary, [...turn(), ...reviewed, ...resent(summary, "p")])).recorded, false);
  assert.deepEqual(await ask(summary, [...turn(), ...reviewed, ...resent({ ...summary, answer: "other" }, "p")]), { recorded: true });
  assert.match((await ask(summary, [...turn(), ...reviewed, ...resent(summary, "p"), ...resent(summary, "q")])).unchecked, /Exceptions doubled/);
});

test("a bot word the user asked about needs no ledger proof, and a stray action never marks a card unchecked", async () => {
  const bot = { ...valid, kind: "summary" as const, title: "Bot requests held steady" };
  const asked = [{ role: "user" as const, content: "how many bot requests yesterday?" }, ...turn().slice(1)];
  assert.deepEqual(await askWith(bot, asked), { recorded: true });
  const third = await ask({ ...valid, action: "None" }, [...turn(), sentBack(), sentBack("q")]);
  assert.deepEqual(third, { recorded: true });
});

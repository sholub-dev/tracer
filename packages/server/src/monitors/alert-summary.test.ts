import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { alertFindingFromMessages, latestRunSummary, dismissalFromMessages, reportAlertSummaryTool, summaryFromMessages } from "./alert-summary.js";

const valid = {
  severity: "low", policy: "p", started: "s", status: "stopped",
  issues: [],
};
const call = (input: unknown) => ({ type: "tool-report_alert_summary", toolCallId: "x", state: "output-available", input, output: {} });

test("summaryFromMessages skips a later call with invalid input and returns the earlier valid one", () => {
  const messages = [{ id: "", role: "assistant", parts: [call(valid), call({ severity: "nope" })] }] as unknown as UIMessage[];
  assert.deepEqual(summaryFromMessages(messages), valid);
});

test("summaryFromMessages returns null when no call is valid", () => {
  const messages = [{ id: "", role: "assistant", parts: [call({ severity: "nope" })] }] as unknown as UIMessage[];
  assert.equal(summaryFromMessages(messages), null);
});

test("dismissalFromMessages returns the reason of a successful call and null without one", () => {
  const part = (state: string) => ({ type: "tool-dismiss_alert", toolCallId: "d", state, input: { reason: "incident 1 closed" } });
  const of = (...parts: unknown[]) => [{ id: "", role: "assistant", parts }] as unknown as UIMessage[];
  assert.equal(dismissalFromMessages(of(part("output-available"))), "incident 1 closed");
  assert.equal(dismissalFromMessages(of(part("output-error"))), null);
  assert.equal(dismissalFromMessages(of(call(valid))), null);
  assert.equal(dismissalFromMessages(of(part("output-available"), call(valid))), null);
  assert.equal(dismissalFromMessages(of(call(valid), part("output-available"))), "incident 1 closed");
});

test("alertFindingFromMessages keeps the finding of the alert run, not of a later follow-up", () => {
  const finding = (headline: string) => ({ type: "tool-report_finding", toolCallId: "f", state: "output-available", input: { kind: "summary", headline, details: "", points: [] } });
  const msg = (...parts: unknown[]) => ({ id: "", role: "assistant", parts });
  const run = [msg(finding("Pool exhausted."), call(valid))];
  const followUp = [...run, { id: "", role: "user", parts: [] }, msg(finding("Errors stopped."))] as unknown as UIMessage[];
  assert.equal(alertFindingFromMessages(followUp)?.headline, "Pool exhausted.");
  assert.equal(alertFindingFromMessages([msg(finding("Only card."))] as unknown as UIMessage[])?.headline, "Only card.");
});

test("latestRunSummary reads the run a steered message trails", () => {
  const user = { id: "u", role: "user", parts: [{ type: "text", text: "alert" }] } as unknown as UIMessage;
  const steered = { id: "s", role: "user", metadata: { steered: true }, parts: [{ type: "text", text: "also check x" }] } as unknown as UIMessage;
  const reply = { id: "", role: "assistant", parts: [call(valid)] } as unknown as UIMessage;
  assert.deepEqual(latestRunSummary([user, reply, steered]), latestRunSummary([user, reply]));
  assert.ok(latestRunSummary([user, reply, steered]));
});

const slackInput = { ...valid, state: "ongoing", notify: false, issues: [{ service: "svc", endpoint: "/a", errors: "318 × Auth0Exception", userImpact: "none" }] };
const sentBackResult = (problems: string) => ({
  role: "tool" as const,
  content: [{ type: "tool-result" as const, toolCallId: "p", toolName: "report_alert_summary", output: { type: "json" as const, value: { recorded: false, problems, next: "n" } } }],
});
const runSummary = (slack: boolean, problems: string | null | undefined) => {
  const seen: number[] = [];
  const t = reportAlertSummaryTool({ slack }, problems === undefined ? undefined : async () => { seen.push(1); return problems; }) as any;
  return { seen, call: (messages: unknown[] = []) => t.execute(slackInput, { messages, toolCallId: "t" }) };
};

test("the alert summary is sent back once, then recorded as written", async () => {
  const { call } = runSummary(true, "- issues: 318 is the endpoint total.");
  const first = await call();
  assert.equal(first.recorded, false);
  assert.match(first.problems, /endpoint total/);
  assert.match(first.next, /call report_alert_summary again/);
  assert.deepEqual(await call([sentBackResult(first.problems)]), { recorded: true });
});

test("an OK or failed review records the summary", async () => {
  assert.deepEqual(await runSummary(true, "OK").call(), { recorded: true });
  assert.deepEqual(await runSummary(true, null).call(), { recorded: true });
});

test("the alert summary is not reviewed without Slack or without a callback", async () => {
  const noSlack = runSummary(false, "- x");
  assert.deepEqual(await noSlack.call(), { recorded: true });
  assert.equal(noSlack.seen.length, 0);
  assert.deepEqual(await runSummary(true, undefined).call(), { recorded: true });
});

test("a summary the review sent back is never read as the report", () => {
  const rejected = { ...call({ ...valid, policy: "rejected" }), output: { recorded: false, problems: "x", next: "y" } };
  const messages = [{ id: "", role: "assistant", parts: [call(valid), rejected] }] as unknown as UIMessage[];
  assert.deepEqual(summaryFromMessages(messages), valid);
  assert.equal(summaryFromMessages([{ id: "", role: "assistant", parts: [rejected] }] as unknown as UIMessage[]), null);
  assert.equal(alertFindingFromMessages([{ id: "", role: "assistant", parts: [rejected] }] as unknown as UIMessage[]), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { alertFindingFromMessages, dismissalFromMessages, summaryFromMessages } from "./alert-summary.js";

const valid = {
  severity: "low", policy: "p", started: "s", status: "stopped", seenBefore: "no",
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

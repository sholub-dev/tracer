import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { serializeMessagesForSummary } from "./summary.js";

test("a card the review sent back is left out of the summary input", () => {
  const card = (output: unknown) => ({ type: "tool-report_finding", toolCallId: "c", state: "output-available", input: { headline: "H" }, output });
  const msg = (output: unknown) => [{ id: "a", role: "assistant", parts: [card(output)] }] as unknown as UIMessage[];
  assert.doesNotMatch(serializeMessagesForSummary(msg({ recorded: false, problems: "x" })), /report_finding/);
  assert.match(serializeMessagesForSummary(msg({ recorded: true })), /\[tool: report_finding\]/);
});

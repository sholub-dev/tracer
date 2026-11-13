import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { endsAnswered } from "./activity.js";

const reply = (...parts: object[]) => ({ id: "a", role: "assistant", parts }) as unknown as UIMessage;

test("a reply holds its answer when text follows its last query, even before a trailing tool", () => {
  const q = { type: "tool-execute_nrql", state: "output-available", input: { title: "Errors" } };
  const timer = { type: "tool-set_timer", state: "output-available" };
  assert.equal(endsAnswered(reply(q, { type: "text", text: "Errors are normal." }, timer)), true);
  assert.equal(endsAnswered(reply({ type: "text", text: "Checking." }, q)), false, "ends on a query");
  const analysis = { type: "tool-begin_analysis", state: "output-available" };
  assert.equal(endsAnswered(reply(q, { type: "text", text: "Narration." }, analysis)), false, "a started analysis owes a card");
});

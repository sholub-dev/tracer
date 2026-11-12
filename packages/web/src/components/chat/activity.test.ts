import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { activityLabel, endsAnswered } from "./activity.js";

const user = { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] } as UIMessage;
const reply = (...parts: object[]) => ({ id: "a", role: "assistant", parts }) as unknown as UIMessage;

test("waiting for the first token reads Thinking", () => {
  assert.equal(activityLabel([user]), "Thinking");
  assert.equal(activityLabel([user, reply({ type: "step-start" })]), "Thinking");
});

test("a running query names its title", () => {
  const q = { type: "tool-execute_nrql", state: "input-available", input: { title: "Error rate" } };
  assert.equal(activityLabel([user, reply(q)]), "Querying Error rate");
});

test("the summary has a writing phase and a review phase", () => {
  assert.equal(activityLabel([user, reply({ type: "tool-report_finding", state: "input-streaming" })]), "Writing the summary");
  assert.equal(activityLabel([user, reply({ type: "tool-report_finding", state: "input-available" })]), "Checking the summary");
});

test("a hidden analysis tool reads Checking the analysis", () => {
  assert.equal(activityLabel([user, reply({ type: "tool-begin_analysis", state: "input-available" })]), "Checking the analysis");
});

test("a settled tool leaves Thinking, streaming text leaves no label", () => {
  const done = { type: "tool-execute_nrql", state: "output-available", input: { title: "x" }, output: [] };
  assert.equal(activityLabel([user, reply(done)]), "Thinking");
  assert.equal(activityLabel([user, reply(done, { type: "text", text: "a", state: "streaming" })]), null);
  assert.equal(activityLabel([user, reply(done, { type: "text", text: "a", state: "done" })]), "Thinking");
});

test("a reply holds its answer when text follows its last query, even before a trailing tool", () => {
  const q = { type: "tool-execute_nrql", state: "output-available", input: { title: "Errors" } };
  const timer = { type: "tool-set_timer", state: "output-available" };
  assert.equal(endsAnswered(reply(q, { type: "text", text: "Errors are normal." }, timer)), true);
  assert.equal(endsAnswered(reply({ type: "text", text: "Checking." }, q)), false, "ends on a query");
  const analysis = { type: "tool-begin_analysis", state: "output-available" };
  assert.equal(endsAnswered(reply(q, { type: "text", text: "Narration." }, analysis)), false, "a started analysis owes a card");
});

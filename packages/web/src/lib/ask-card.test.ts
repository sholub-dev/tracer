import { test } from "node:test";
import assert from "node:assert/strict";
import { askState } from "./ask-card.js";

const ask = { question: "Go deeper?", options: [{ label: "Yes, trace the deploy" }, { label: "No, this is enough", detail: "Stop here" }] };
const user = (text: string, metadata?: object) => ({ role: "user", parts: [{ type: "text", text }], metadata });
const reply = { role: "assistant", parts: [{ type: "tool-ask_user" }] };

test("the card of the last finished reply is open", () => {
  assert.deepEqual(askState([user("why?"), reply], 1, ask, false), { status: "open" });
});

test("the card is closed while the reply streams", () => {
  assert.deepEqual(askState([user("why?"), reply], 1, ask, true), { status: "closed" });
});

test("a steered message saved after the reply does not answer the card", () => {
  assert.deepEqual(askState([user("why?"), reply, user("also check X", { steered: true })], 1, ask, false), { status: "open" });
});

test("the next user message answers the card; an option label is the chosen option", () => {
  assert.deepEqual(askState([user("why?"), reply, user("No, this is enough")], 1, ask, false), { status: "answered", chosen: 1 });
  assert.deepEqual(askState([user("why?"), reply, user("  Yes, trace the deploy\n")], 1, ask, false), { status: "answered", chosen: 0 });
});

test("a typed answer chooses no option but still answers the card", () => {
  assert.deepEqual(askState([user("why?"), reply, user("check the cache instead")], 1, ask, false), { status: "answered", chosen: null });
});

test("a card of an earlier reply with a later reply and no answer in between is closed", () => {
  assert.deepEqual(askState([user("why?"), reply, { role: "assistant", parts: [{ type: "text", text: "x" }] }], 1, ask, false), { status: "closed" });
});

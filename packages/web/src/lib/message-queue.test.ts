import { test } from "node:test";
import assert from "node:assert/strict";
import { appendKept, canSendQueued, lastTurnMessage, splitSteered } from "./message-queue.js";

const base = { status: "ready", held: false, queued: 1, locked: false };

test("a queued message is sent when the reply ended cleanly", () => {
  assert.equal(canSendQueued(base), true);
});

test("a queued message waits while a reply runs, after an error, after a stop and while locked", () => {
  assert.equal(canSendQueued({ ...base, status: "streaming" }), false);
  assert.equal(canSendQueued({ ...base, status: "submitted" }), false);
  assert.equal(canSendQueued({ ...base, status: "error" }), false);
  assert.equal(canSendQueued({ ...base, held: true }), false);
  assert.equal(canSendQueued({ ...base, locked: true }), false);
});

test("nothing is sent from an empty queue", () => {
  assert.equal(canSendQueued({ ...base, queued: 0 }), false);
});

test("a steered message the agent saw is kept; one it did not see is sent again, never both", () => {
  const steered = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { kept, late } = splitSteered(steered, new Set(["a", "c"]));
  assert.deepEqual(kept, [{ id: "a" }, { id: "c" }]);
  assert.deepEqual(late, [{ id: "b" }]);
  assert.deepEqual(splitSteered(steered, new Set()).kept, []);
});

test("an id found in the saved history counts as kept even when the live event was missed", () => {
  const saved = new Set(["b"]);
  const { kept, late } = splitSteered([{ id: "a" }, { id: "b" }], new Set([...saved]));
  assert.deepEqual(kept, [{ id: "b" }]);
  assert.deepEqual(late, [{ id: "a" }]);
});

test("a steered message saved after the reply is not the last turn message", () => {
  const thread = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "s1", role: "user", metadata: { steered: true } },
    { id: "s2", role: "user", metadata: { steered: true } },
  ];
  assert.equal(lastTurnMessage(thread)?.id, "a1");
  assert.equal(lastTurnMessage(thread.slice(0, 1))?.id, "u1");
  assert.equal(lastTurnMessage([]), undefined);
});

test("a kept steered message that the thread already holds is not added twice", () => {
  const thread = [{ id: "u1" }, { id: "a1" }, { id: "s1" }];
  assert.deepEqual(appendKept(thread, [{ id: "s1" }, { id: "s2" }]).map((m) => m.id), ["u1", "a1", "s1", "s2"]);
  assert.deepEqual(appendKept(thread, [{ id: "s1" }]), thread);
});

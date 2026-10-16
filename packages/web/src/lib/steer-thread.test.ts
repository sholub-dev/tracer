import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { placeSteered } from "./steer-thread";
import { withLiveReply } from "./live-stream";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const steered = (id: string, metadata: object): UIMessage => ({ id, role: "user", metadata: { steered: true, ...metadata }, parts: [{ type: "text", text: id }] });
const step = { type: "step-start" } as const;
const text = (t: string) => ({ type: "text", text: t }) as const;
const reply = (...parts: UIMessage["parts"]): UIMessage => ({ id: "", role: "assistant", parts });
const shape = (rows: ReturnType<typeof placeSteered>) => rows.map((r) => r.msg.role === "user" ? r.msg.id : r.msg.parts.map((p) => (p.type === "text" ? p.text : p.type)).join("+"));

const four = reply(step, text("a"), step, text("b"), step, text("c"));

test("a steered message sits before the step it landed at", () => {
  const rows = placeSteered([user("q", "why?"), four, steered("s", { anchor: 1 })], []);
  assert.deepEqual(shape(rows), ["q", "step-start+a", "s", "step-start+b+step-start+c"]);
  assert.deepEqual(rows.map((r) => r.last), [true, false, true, true]);
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2, 1]);
});

test("several steered messages split the reply in order, and equal anchors keep the send order", () => {
  const rows = placeSteered([user("q", "why?"), four, steered("s1", { anchor: 1 }), steered("s2", { anchor: 1 }), steered("s3", { anchor: 2 })], []);
  assert.deepEqual(shape(rows), ["q", "step-start+a", "s1", "s2", "step-start+b", "s3", "step-start+c"]);
});

test("a message with no anchor stays after the reply, as before", () => {
  const rows = placeSteered([user("q", "why?"), four, steered("old", {})], []);
  assert.deepEqual(shape(rows), ["q", "step-start+a+step-start+b+step-start+c", "old"]);
});

test("a sent message holds the place where it was sent while the reply grows", () => {
  const sentAt = steered("p", { at: 3 });
  const growing = (n: number) => reply(step, text("a"), step, text("b"), ...(n > 4 ? [text("more")] : []), ...(n > 5 ? [step, text("next")] : []));
  assert.deepEqual(shape(placeSteered([user("q", "?"), growing(4)], [sentAt])), ["q", "step-start+a+step-start", "p", "b"]);
  assert.deepEqual(shape(placeSteered([user("q", "?"), growing(6)], [sentAt])), ["q", "step-start+a+step-start", "p", "b+more+step-start+next"]);
});

test("the accepted step wins over the place where it was sent", () => {
  const accepted = steered("p", { at: 3, anchor: 2 });
  assert.deepEqual(shape(placeSteered([user("q", "?"), four], [accepted])), ["q", "step-start+a+step-start+b", "p", "step-start+c"]);
});

test("an anchor whose step has not arrived yet keeps the sent place, then the end", () => {
  const early = reply(step, text("a"));
  assert.deepEqual(shape(placeSteered([user("q", "?"), early], [steered("p", { at: 1, anchor: 1 })])), ["q", "p", "a"]);
  assert.deepEqual(shape(placeSteered([user("q", "?"), early], [steered("p", { anchor: 1 })])), ["q", "step-start+a", "p"]);
});

test("a pending message the saved history already holds is shown once", () => {
  const saved = steered("s", { anchor: 1 });
  assert.deepEqual(shape(placeSteered([user("q", "?"), four, saved], [{ ...saved }])), ["q", "step-start+a", "s", "step-start+b+step-start+c"]);
});

test("a message sent before the reply starts follows the question", () => {
  assert.deepEqual(shape(placeSteered([user("q", "?")], [steered("p", {})])), ["q", "p"]);
});

test("a reattached reply keeps the anchor of the saved steered message", () => {
  const saved = [user("q", "?"), reply(step, text("a")), steered("s", { anchor: 1 })];
  const live = reply(step, text("a"), step, text("b"));
  assert.deepEqual(shape(placeSteered(withLiveReply(saved, live), [])), ["q", "step-start+a", "s", "step-start+b"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { nextEndState, withLiveReply } from "./live-stream";

test("repeated 404s notify the parent once", () => {
  let notified = false;
  const fired: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const r = nextEndState(notified, "ended");
    notified = r.notified;
    fired.push(r.notify);
  }
  assert.deepEqual(fired, [true, false, false]);
});

test("a reopened connection re-arms the notice", () => {
  let s = nextEndState(false, "ended");
  s = nextEndState(s.notified, "failed");
  assert.equal(s.notify, false);
  s = nextEndState(s.notified, "open");
  assert.equal(nextEndState(s.notified, "ended").notify, true);
});

test("a finished stream always notifies", () => {
  assert.equal(nextEndState(true, "finished").notify, true);
});

test("a reattached run replaces its saved reply even when a steered message trails it", () => {
  const user = { id: "u", role: "user", parts: [{ type: "text", text: "why?" }] } as UIMessage;
  const steered = { id: "s", role: "user", metadata: { steered: true }, parts: [{ type: "text", text: "check x" }] } as UIMessage;
  const saved = { id: "", role: "assistant", parts: [{ type: "tool-q", toolCallId: "t1", state: "output-available" }] } as unknown as UIMessage;
  const live = { id: "", role: "assistant", parts: [{ type: "tool-q", toolCallId: "t1", state: "output-available" }, { type: "text", text: "so" }] } as unknown as UIMessage;
  assert.deepEqual(withLiveReply([user, saved, steered], live).map((m) => m.id), ["u", "", "s"]);
  assert.deepEqual(withLiveReply([user, saved], live).map((m) => m.id), ["u", ""]);
});

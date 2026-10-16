import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import type { Context } from "../trpc/context.js";
import { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import { drainSteer, newSteerState, steerChat } from "./steer.js";

const msg = (text: string): UIMessage => ({ id: "", role: "user", parts: [{ type: "text", text }] });

test("draining moves waiting messages into the run, in order, once", () => {
  const state = newSteerState();
  state.pending.push(msg("a"), msg("b"));
  assert.deepEqual(drainSteer(state).map((m) => m.parts[0]), [{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  assert.equal(state.pending.length, 0);
  assert.equal(state.steered.length, 2);
  assert.deepEqual(drainSteer(state), []);
  assert.equal(state.steered.length, 2);
});

test("a steer message waits on the active run with its send time; with no run it is refused", async () => {
  const steer = newSteerState();
  const context = {
    db: { select: () => ({ from: () => ({ where: () => ({ get: async () => undefined }), get: async () => undefined }) }) },
    activeStreams: new Map([["s1", { broadcaster: new StreamBroadcaster(), controller: new AbortController(), steer }]]),
  } as unknown as Context;
  assert.equal(await steerChat(context, "s1", msg("look at the db")), true);
  assert.equal(steer.pending.length, 1);
  assert.ok((steer.pending[0].metadata as { sentTime?: string }).sentTime);
  assert.equal(await steerChat(context, "other", msg("hi")), false);
});

test("two messages sent at once keep their order", async () => {
  const steer = newSteerState();
  let reads = 0;
  // The first time read is the slowest.
  const get = async () => { const n = reads++; await new Promise((r) => setTimeout(r, n === 0 ? 40 : 1)); return undefined; };
  const context = {
    db: { select: () => ({ from: () => ({ where: () => ({ get }), get }) }) },
    activeStreams: new Map([["s1", { broadcaster: new StreamBroadcaster(), controller: new AbortController(), steer }]]),
  } as unknown as Context;
  await Promise.all([steerChat(context, "s1", msg("first")), steerChat(context, "s1", msg("second"))]);
  assert.deepEqual(steer.pending.map((m) => (m.parts[0] as { text: string }).text), ["first", "second"]);
  assert.ok(steer.pending.every((m) => (m.metadata as { sentTime?: string }).sentTime));
});

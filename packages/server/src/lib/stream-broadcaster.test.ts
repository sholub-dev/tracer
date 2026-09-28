import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamBroadcaster } from "./stream-broadcaster.js";

const parts: Record<string, unknown>[] = [
  { type: "start-step" },
  { type: "reasoning-start", id: "r1" },
  { type: "reasoning-delta", id: "r1", delta: "Think" },
  { type: "reasoning-delta", id: "r1", delta: "ing" },
  { type: "reasoning-end", id: "r1" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Hel" },
  { type: "text-delta", id: "t1", delta: "lo " },
  { type: "text-delta", id: "t1", delta: "world" },
  { type: "text-delta", id: "t2", delta: "other" },
  { type: "tool-input-start", toolCallId: "c1", toolName: "q" },
  { type: "text-delta", id: "t1", delta: "again" },
  { type: "text-end", id: "t1" },
];

test("replay merges consecutive same-id deltas and keeps every other part in order", () => {
  const b = new StreamBroadcaster();
  for (const p of parts) b.emit(p);
  const replay: Record<string, unknown>[] = [];
  b.subscribe((p) => replay.push(p));
  assert.deepEqual(replay, [
    { type: "start-step" },
    { type: "reasoning-start", id: "r1" },
    { type: "reasoning-delta", id: "r1", delta: "Thinking" },
    { type: "reasoning-end", id: "r1" },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Hello world" },
    { type: "text-delta", id: "t2", delta: "other" },
    { type: "tool-input-start", toolCallId: "c1", toolName: "q" },
    { type: "text-delta", id: "t1", delta: "again" },
    { type: "text-end", id: "t1" },
  ]);
});

test("live subscribers get original parts and already-delivered objects are never mutated", () => {
  const b = new StreamBroadcaster();
  const live: Record<string, unknown>[] = [];
  b.subscribe((p) => live.push(p));
  b.emit(parts[5]);
  b.emit(parts[6]);
  const lateReplay: Record<string, unknown>[] = [];
  b.subscribe((p) => lateReplay.push(p));
  const heldDelta = lateReplay[1];
  b.emit(parts[7]);
  b.emit(parts[8]);

  assert.deepEqual(live, parts.slice(5, 9));
  assert.ok(live.every((p, i) => p === parts[5 + i]));
  assert.deepEqual(parts[6], { type: "text-delta", id: "t1", delta: "Hel" });
  assert.deepEqual(heldDelta, { type: "text-delta", id: "t1", delta: "Hel" });

  const replay: Record<string, unknown>[] = [];
  b.subscribe((p) => replay.push(p));
  assert.deepEqual(replay[1], { type: "text-delta", id: "t1", delta: "Hello world" });
});

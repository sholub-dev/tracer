import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionChanged, sessionChanges } from "./session-events.js";

test("sessionChanges yields every changed id in order and ends when the signal aborts", async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  const done = (async () => {
    for await (const id of sessionChanges(controller.signal)) {
      seen.push(id);
      if (seen.length === 3) controller.abort();
    }
  })();
  await new Promise((r) => setTimeout(r, 0));
  sessionChanged("a", "b");
  sessionChanged("c");
  await done;
  assert.deepEqual(seen, ["a", "b", "c"]);
  sessionChanged("d");
  assert.deepEqual(seen, ["a", "b", "c"], "no listener is left behind");
});

test("sessionChanges ends at once when aborted while waiting", async () => {
  const controller = new AbortController();
  const done = (async () => { for await (const _ of sessionChanges(controller.signal)) { /* none */ } })();
  await new Promise((r) => setTimeout(r, 0));
  controller.abort();
  await done;
});

test("a subscriber that does not read holds each waiting session once", async () => {
  const controller = new AbortController();
  const gen = sessionChanges(controller.signal);
  const first = gen.next();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5000; i++) sessionChanged(`s${i % 3}`);
  const seen = [(await first).value as string];
  for (let i = 0; i < 2; i++) seen.push((await gen.next()).value as string);
  controller.abort();
  assert.deepEqual(seen, ["s0", "s1", "s2"]);
  assert.equal((await gen.next()).done, true);
});

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

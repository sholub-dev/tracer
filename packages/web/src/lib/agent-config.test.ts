import { test } from "node:test";
import assert from "node:assert/strict";
import { syncEdits } from "./agent-config";

const saved = { timezone: "UTC", steps: 10, budget: 0 };

test("an edit typed while a save refetches survives", () => {
  const submitted = { ...saved, steps: 20 };
  const typed = { ...submitted, budget: 2048 };
  assert.deepEqual(syncEdits(typed, saved, submitted), { timezone: "UTC", steps: 20, budget: 2048 });
});

test("untouched fields follow the server", () => {
  assert.deepEqual(syncEdits(saved, saved, { ...saved, timezone: "Asia/Tokyo" }), { ...saved, timezone: "Asia/Tokyo" });
});

test("the first load takes the server values", () => {
  assert.deepEqual(syncEdits(saved, null, saved), saved);
});

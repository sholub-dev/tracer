import { test } from "node:test";
import assert from "node:assert/strict";
import { takeFreshKeys } from "./answer-cards.js";

test("a key is fresh only once", () => {
  const seen = new Set<string>();
  assert.deepEqual(takeFreshKeys(seen, ["3:0"]), ["3:0"]);
  assert.deepEqual(takeFreshKeys(seen, ["3:0"]), []);
});

test("a new card next to a known card is fresh", () => {
  const seen = new Set(["1:0"]);
  assert.deepEqual(takeFreshKeys(seen, ["1:0", "3:0"]), ["3:0"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesQuery } from "./session-search";

test("an empty or blank query matches everything", () => {
  assert.equal(matchesQuery("Checkout errors", ""), true);
  assert.equal(matchesQuery("Checkout errors", "   "), true);
  assert.equal(matchesQuery("", ""), true);
});

test("matching ignores case", () => {
  assert.equal(matchesQuery("Checkout errors", "CHECKOUT"), true);
  assert.equal(matchesQuery("checkout errors", "Errors"), true);
});

test("all words must match, in any order", () => {
  assert.equal(matchesQuery("Checkout errors spike", "spike checkout"), true);
  assert.equal(matchesQuery("Checkout errors spike", "checkout latency"), false);
});

test("surrounding and repeated whitespace is ignored", () => {
  assert.equal(matchesQuery("Checkout errors", "  checkout   errors  "), true);
});

test("a query that is not in the title does not match", () => {
  assert.equal(matchesQuery("Checkout errors", "billing"), false);
});

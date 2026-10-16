import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCheckForAppUpdate, shouldOfferAppUpdate } from "./app-update.js";

const HOUR = 60 * 60 * 1000;

test("the first check of a launch always runs", () => {
  assert.equal(shouldCheckForAppUpdate(null, 1000, HOUR), true);
});

test("a check inside the minimum interval is skipped", () => {
  assert.equal(shouldCheckForAppUpdate(1000, 1000 + HOUR - 1, HOUR), false);
  assert.equal(shouldCheckForAppUpdate(1000, 1000 + HOUR, HOUR), true);
});

test("the offer needs a newer release", () => {
  assert.equal(shouldOfferAppUpdate("0.7.18", "0.7.19", null), true);
  assert.equal(shouldOfferAppUpdate("0.7.18", "0.7.18", null), false);
  assert.equal(shouldOfferAppUpdate("0.7.19", "0.7.18", null), false);
});

test("a dismissed version is not offered again, a newer one is", () => {
  assert.equal(shouldOfferAppUpdate("0.7.18", "0.7.19", "0.7.19"), false);
  assert.equal(shouldOfferAppUpdate("0.7.18", "0.7.20", "0.7.19"), true);
});

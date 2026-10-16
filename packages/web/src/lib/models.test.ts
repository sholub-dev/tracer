import { test } from "node:test";
import assert from "node:assert/strict";
import { AVAILABLE_MODELS, computeCost } from "./models.js";

test("cache-write tokens are billed once, at the write multiplier", () => {
  const m = AVAILABLE_MODELS.find((x) => x.provider === "anthropic" && !("priceAfter" in x))!;
  // Input total includes the cache reads and writes: 100 plain + 200 read + 1000 written.
  const cost = computeCost(m.modelId, 1300, 0, 200, 1000);
  const expected = (100 * m.inputPrice + 200 * m.inputPrice * m.cacheReadMultiplier + 1000 * m.inputPrice * m.cacheWriteMultiplier) / 1_000_000;
  assert.ok(Math.abs(cost - expected) < 1e-12, `cost ${cost}, expected ${expected}`);
});

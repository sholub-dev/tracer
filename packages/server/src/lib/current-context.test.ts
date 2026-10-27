import { test } from "node:test";
import assert from "node:assert/strict";
import { getCurrentDateBlock, getTimezone, isValidTimezone } from "./current-context.js";
import { DEFAULTS } from "../config.js";

test("isValidTimezone accepts IANA names and rejects junk", () => {
  assert.equal(isValidTimezone("Europe/Berlin"), true);
  assert.equal(isValidTimezone("Mars/Base"), false);
});

test("getTimezone falls back to the default when the env value is invalid", async () => {
  const saved = process.env.TRACER_TIMEZONE;
  try {
    assert.ok(typeof (await getTimezone()) === "string");
    assert.ok(isValidTimezone(await getTimezone()));
    assert.ok(isValidTimezone(DEFAULTS.timezone));
  } finally {
    if (saved === undefined) delete process.env.TRACER_TIMEZONE; else process.env.TRACER_TIMEZONE = saved;
  }
});

test("the date block names a provider's time rule only when that provider is connected", async () => {
  assert.doesNotMatch(await getCurrentDateBlock(), /New Relic|PostHog/);
  const nr = await getCurrentDateBlock(undefined, ["newrelic"]);
  assert.match(nr, /New Relic/);
  assert.doesNotMatch(nr, /PostHog/);
  const ph = await getCurrentDateBlock(undefined, ["posthog"]);
  assert.match(ph, /PostHog/);
  assert.doesNotMatch(ph, /New Relic/);
});

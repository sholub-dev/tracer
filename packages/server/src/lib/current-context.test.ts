import { test } from "node:test";
import assert from "node:assert/strict";
import { getTimezone, isValidTimezone } from "./current-context.js";
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

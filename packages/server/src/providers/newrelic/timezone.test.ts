import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTimestamps } from "@tracer-sh/shared";
import { withTimezone } from "./tools.js";

test("withTimezone appends the user's zone once and skips SHOW queries", () => {
  assert.equal(withTimezone("SELECT count(*) FROM Log SINCE 1 hour ago", "America/Los_Angeles"),
    "SELECT count(*) FROM Log SINCE 1 hour ago WITH TIMEZONE 'America/Los_Angeles'");
  assert.equal(withTimezone("SELECT 1 FROM Log WITH TIMEZONE 'UTC'", "America/Los_Angeles"), "SELECT 1 FROM Log WITH TIMEZONE 'UTC'");
  assert.equal(withTimezone("SHOW EVENT TYPES", "America/Los_Angeles"), "SHOW EVENT TYPES");
});

test("formatTimestamps renders times in the given zone with its label", () => {
  const [row] = formatTimestamps([{ beginTimeSeconds: 1790229600 }], "America/Los_Angeles") as Record<string, string>[];
  assert.equal(row.beginTimeSeconds, "2026-09-23 23:00:00 PDT");
  const [utc] = formatTimestamps([{ beginTimeSeconds: 1790229600 }]) as Record<string, string>[];
  assert.equal(utc.beginTimeSeconds, "2026-09-24 06:00:00 UTC");
});

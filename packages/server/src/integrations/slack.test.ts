import { test } from "node:test";
import assert from "node:assert/strict";
import { isSlackWebhook, monitorAlertText, parseMentions, parseVerdict, postSlack, redact } from "./slack.js";

test("isSlackWebhook accepts only Slack webhook URLs", () => {
  assert.equal(isSlackWebhook("https://hooks.slack.com/services/T0/B0/x"), true);
  assert.equal(isSlackWebhook("http://hooks.slack.com/services/T0/B0/x"), false);
  assert.equal(isSlackWebhook("https://hooks.slack.com.evil.io/services/x"), false);
});

test("postSlack refuses non-Slack URLs without a request", async () => {
  assert.ok("error" in (await postSlack("https://example.com/hook", "hi")));
});

test("parseMentions maps IDs and specials, rejects names", () => {
  assert.deepEqual(parseMentions("U0123ABCD, @here S0999XYZ1"), { mentions: ["<@U0123ABCD>", "<!here>", "<!subteam^S0999XYZ1>"] });
  assert.deepEqual(parseMentions(""), { mentions: [] });
  assert.ok("error" in parseMentions("@sholub"));
});

test("parseVerdict reads closing lines, falls back to first sentence", () => {
  assert.deepEqual(
    parseVerdict("## Why it failed\nDetails.\n\n**Severity:** High\n**TL;DR:** DB timeouts after the 1.2 deploy.\n**Why:** Pool maxed at 10:02.\nSeen before: No.\nNext step: `Roll back` 1.2."),
    { severity: "high", summary: "DB timeouts after the 1.2 deploy.", details: [["Why", "Pool maxed at 10:02."], ["Seen before", "No."], ["Next step", "Roll back 1.2."]] },
  );
  assert.deepEqual(parseVerdict("## Root cause\nThe `db` pool ran out. More text."), { severity: "unknown", summary: "The db pool ran out.", details: [] });
});

test("redact masks personal data, keeps normal text", () => {
  assert.equal(
    redact("jo.d+x@corp.com 123-45-6789 (415) 555-1234 loan 1234567890 at 10:05 in svc-a v1.2"),
    "[email] [ssn] [phone] loan [number] at 10:05 in svc-a v1.2",
  );
  assert.equal(
    redact("GET /api/loans/7?token=abc&x=1 by 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f"),
    "GET /api/loans/7?[query] by [id]",
  );
});

test("monitorAlertText tags, shows severity, root cause and details, escapes", () => {
  const text = monitorAlertText({
    name: "Errors <prod>",
    groups: ["svc-a", ""],
    triggeredAt: 1_767_225_600,
    analysis: "Long analysis.\nSeverity: critical\nTL;DR: Checkout is down & failing.\nWhy: 500s from pay-api.\nAffected: All checkouts.",
    timeZone: "UTC",
    mentions: "U0123ABCD",
  });
  assert.deepEqual(text.split("\n"), [
    "<@U0123ABCD> *[CRITICAL] Checkout is down &amp; failing.*",
    "Why: 500s from pay-api.",
    "Affected: All checkouts.",
    '_svc-a · monitor "Errors &lt;prod&gt;" · Jan 1, 12:00 AM UTC_',
  ]);
});

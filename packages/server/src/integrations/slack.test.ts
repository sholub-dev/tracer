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
    parseVerdict("## Root cause\nDetails.\n\n**Severity:** High\n**TL;DR:** DB timeouts after the 1.2 deploy."),
    { severity: "high", summary: "DB timeouts after the 1.2 deploy." },
  );
  assert.deepEqual(parseVerdict("## Root cause\nThe `db` pool ran out. More text."), { severity: "unknown", summary: "The db pool ran out." });
});

test("redact masks personal data, keeps normal text", () => {
  assert.equal(
    redact("jo.d+x@corp.com 123-45-6789 (415) 555-1234 loan 1234567890 at 10:05 in svc-a v1.2"),
    "[email] [ssn] [phone] loan [number] at 10:05 in svc-a v1.2",
  );
});

test("monitorAlertText tags, shows severity and root cause first, escapes", () => {
  const text = monitorAlertText({
    name: "Errors <prod>",
    condition: "> 0",
    value: 3,
    groups: ["svc-a", ""],
    triggeredAt: 1_767_225_600,
    analysis: "Long analysis.\nSeverity: critical\nTL;DR: Checkout is down & failing.",
    timeZone: "UTC",
    mentions: "U0123ABCD",
  });
  const [head, affected, source] = text.split("\n");
  assert.equal(head, "<@U0123ABCD> *[CRITICAL] Checkout is down &amp; failing.*");
  assert.equal(affected, "Affected: svc-a");
  assert.match(source, /^_Found by monitor "Errors &lt;prod&gt;" \(count 3, condition &gt; 0\) at Jan 1, 12:00 AM UTC_$/);
});

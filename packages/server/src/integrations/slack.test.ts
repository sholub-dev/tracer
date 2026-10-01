import { test } from "node:test";
import assert from "node:assert/strict";
import { isSlackWebhook, monitorAlert, parseMentions, parseVerdict, postSlack, redact, triageUpdate } from "./slack.js";

test("isSlackWebhook accepts only Slack webhook URLs", () => {
  assert.equal(isSlackWebhook("https://hooks.slack.com/services/T0/B0/x"), true);
  assert.equal(isSlackWebhook("http://hooks.slack.com/services/T0/B0/x"), false);
  assert.equal(isSlackWebhook("https://hooks.slack.com.evil.io/services/x"), false);
});

test("postSlack refuses non-Slack URLs without a request", async () => {
  assert.ok("error" in (await postSlack("https://example.com/hook", { text: "hi" })));
});

test("parseMentions maps IDs and specials, rejects names", () => {
  assert.deepEqual(parseMentions("U0123ABCD, @here S0999XYZ1"), { mentions: ["<@U0123ABCD>", "<!here>", "<!subteam^S0999XYZ1>"] });
  assert.deepEqual(parseMentions(""), { mentions: [] });
  assert.ok("error" in parseMentions("@sholub"));
});

test("parseVerdict reads closing lines and issues, hides unknowns, falls back to first sentence", () => {
  assert.deepEqual(
    parseVerdict("Issue: body line\n**Severity:** High\n**TL;DR:** DB timeouts after the 1.2 deploy.\nPolicy: Errors\nStarted: unknown\nIssue: `pay-api` | /pay | 3 × Timeout | unknown | Checkout\nIssue: unknown | /cart | 1 × Timeout\nSeen before: No.\nNext step: Roll back."),
    {
      severity: "high",
      summary: "DB timeouts after the 1.2 deploy.",
      facts: [["Policy", "Errors"]],
      issues: [["pay-api", "/pay", "3 × Timeout", "", "Checkout"], ["", "/cart", "1 × Timeout"]],
      seenBefore: "No.",
    },
  );
  assert.deepEqual(parseVerdict("## Root cause\nThe `db` pool ran out. More text."), { severity: "unknown", summary: "The db pool ran out.", facts: [], issues: [], seenBefore: "" });
});

test("redact masks personal data, keeps normal text", () => {
  assert.equal(
    redact("jo.d+x@corp.com 123-45-6789 (415) 555-1234 loan 1234567890 at 10:05 in svc-a v1.2"),
    "[email] [ssn] [phone] loan [number] at 10:05 in svc-a v1.2",
  );
  assert.equal(
    redact("GET /api/loans/7?token=abc&x=1 by 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f"),
    "GET /api/loans/{id}?[query] by [id]",
  );
  assert.equal(redact("yes, 08:30 PDT (session 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f), same cause"), "yes, 08:30 PDT, same cause");
  assert.equal(redact("card 4111 1111 1111 1111 on /v1/loans/12345678/pay at 9/29"), "card [number] on /v1/loans/{id}/pay at 9/29");
});

test("monitorAlert builds one compact section and a footer, escapes", () => {
  const { text, blocks } = monitorAlert({
    name: "Errors <prod>",
    triggeredAt: 1_767_225_600,
    analysis: "Long analysis.\nSeverity: critical\nTL;DR: Checkout is down & failing.\nPolicy: Errors\nStarted: 10:02 UTC\nStatus: stopped (last error at 10:09 UTC)\nCount: 40 failed\nIssue: pay-api | /pay | 40 × Timeout | Pay fails | Checkout\nIssue: unknown | /cart | 1 × <Err>\nSeen before: No.",
    timeZone: "UTC",
    mentions: "U0123ABCD",
  });
  assert.equal(text, "<@U0123ABCD> *[CRITICAL] Checkout is down &amp; failing.*");
  assert.deepEqual(blocks, [
    { type: "section", text: { type: "mrkdwn", text: [
      text,
      "*Policy:* Errors  ·  *Started:* 10:02 UTC  ·  *Status:* stopped (last error at 10:09 UTC)",
      "• *pay-api* `/pay`: 40 × Timeout. Pay fails. Funnel: Checkout",
      "• `/cart`: 1 × &lt;Err&gt;",
      "*Seen before:* No.",
    ].join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn", text: 'monitor "Errors &lt;prod&gt;" · Jan 1, 12:00 AM UTC' }] },
  ]);
});

test("monitorAlert stays under Slack's section limit", () => {
  const long = "x".repeat(400);
  const analysis = `Severity: high\nTL;DR: ${long}\n${Array.from({ length: 6 }, () => `Issue: ${Array(5).fill(long).join(" | ")}`).join("\n")}`;
  const section = monitorAlert({ name: "m", triggeredAt: 0, analysis, timeZone: "UTC" }).blocks[0] as { text: { text: string } };
  assert.ok(section.text.text.length <= 3000);
});

test("parseVerdict redacts before clipping", () => {
  const issue = parseVerdict(`Severity: low\nIssue: ${"x".repeat(290)} jo.doe@corp.com`).issues[0][0];
  assert.ok(issue.endsWith("[email]"), issue);
});

test("monitorAlert puts the Action in its own block and skips mentions when no ping is needed", () => {
  const alert = (ping?: boolean, action = "Acked and closed in New Relic: Errors on /pay <x> by jo@corp.com") => monitorAlert({
    name: "m", triggeredAt: 0, timeZone: "UTC", mentions: "U0123ABCD", ping,
    analysis: "Severity: low\nTL;DR: Noise.\nPolicy: Errors\nIssue: api | /pay | 1 × Timeout",
    action,
  });
  const { blocks } = alert(false);
  assert.deepEqual(blocks.slice(0, 2), [
    { type: "section", text: { type: "mrkdwn", text: ["*[LOW] Noise.*", "*Policy:* Errors", "• *api* `/pay`: 1 × Timeout"].join("\n") } },
    { type: "section", text: { type: "mrkdwn", text: "*Action:* Acked and closed in New Relic: Errors on /pay &lt;x&gt; by [email]" } },
  ]);
  assert.equal((blocks[2] as { type: string }).type, "context");
  const long = (alert(false, "<".repeat(3000)).blocks[1] as { text: { text: string } }).text.text;
  assert.ok(long.length <= 3000 && long.endsWith(" …"), String(long.length));
  assert.ok(alert(true).text.startsWith("<@U0123ABCD> "));
  assert.ok(alert().text.startsWith("<@U0123ABCD> "));
});

test("triageUpdate is one line, mentions only on ping", () => {
  assert.equal(triageUpdate({ name: "Errors", action: "Closed in New Relic: High <rate>", ping: false, mentions: "U0123ABCD" }).text, "*Errors:* Closed in New Relic: High &lt;rate&gt;");
  assert.equal(triageUpdate({ name: "Errors", action: "Left open (still ongoing after 24h): x", ping: true, mentions: "@here" }).text, "<!here> *Errors:* Left open (still ongoing after 24h): x");
});

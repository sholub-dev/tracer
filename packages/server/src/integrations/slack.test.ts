import { test } from "node:test";
import assert from "node:assert/strict";
import { isSlackWebhook, monitorAlert, parseMentions, postSlack, redact, triageUpdate, verdictOf } from "./slack.js";
import type { Finding } from "@tracer-sh/shared";
import type { AlertSummary } from "../monitors/alert-summary.js";

const issue = (service: string, endpoint: string, errors: string, userImpact = "", journeyStep = "") => ({ service, endpoint, errors, userImpact, journeyStep });
const finding = (f: Partial<Finding> = {}): Finding => ({ kind: "root_cause", headline: "", details: "", points: [], confidence: "likely", ...f });
const summary = (s: Partial<AlertSummary>): AlertSummary => ({
  severity: "low", policy: "", started: "", status: "", issues: [], seenBefore: "", ...s,
});

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

test("verdictOf hides unknowns and shows no summary text without a report", () => {
  assert.deepEqual(
    verdictOf(summary({
      severity: "high", policy: "Errors", started: "unknown",
      issues: [issue("`pay-api`", "/pay", "3 × Timeout", "unknown", "Checkout"), issue("unknown", "/cart", "1 × Timeout"), issue("n/a", "", "")],
      seenBefore: "No.",
    }), finding({ headline: "**DB** timeouts after the 1.2 deploy.", details: "Pool size dropped to 5 in 1.2.", confidence: undefined })),
    {
      severity: "high",
      summary: "DB timeouts after the 1.2 deploy.",
      rootCause: "Pool size dropped to 5 in 1.2.",
      confidence: "unverified",
      facts: [["Policy", "Errors"]],
      issues: [["pay-api", "/pay", "3 × Timeout", "", "Checkout"], ["", "/cart", "1 × Timeout", "", ""]],
      seenBefore: "No.",
    },
  );
  assert.deepEqual(verdictOf(null, null), { severity: "unknown", summary: "", rootCause: "", confidence: "", facts: [], issues: [], seenBefore: "" });
});

test("verdictOf takes the headline, root cause and confidence from the finding", () => {
  const v = verdictOf(null, finding({ headline: "Pool exhausted.", details: "The pool held 50 of 50.", confidence: "confirmed" }));
  assert.deepEqual([v.summary, v.rootCause, v.confidence], ["Pool exhausted.", "The pool held 50 of 50.", "confirmed"]);
  const s = verdictOf(summary({ severity: "high" }), finding({ kind: "summary", headline: "Checkout is healthy.", details: "Errors stayed at 0.2%.", confidence: undefined }));
  assert.deepEqual([s.severity, s.summary, s.rootCause], ["high", "Checkout is healthy.", ""]);
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
    summary: summary({
      severity: "high", policy: "Errors", started: "10:02 UTC",
      status: "stopped (last error at 10:09 UTC)", issues: [issue("pay-api", "/pay", "40 × Timeout", "Pay fails", "Checkout"), issue("unknown", "/cart", "1 × <Err>")],
      seenBefore: "No.",
    }),
    finding: finding({ headline: "Checkout is down & failing.", details: "pay-db ran out of connections." }),
    timeZone: "UTC",
    mentions: "U0123ABCD",
  });
  assert.equal(text, "<@U0123ABCD> *[HIGH :red_circle:] Checkout is down &amp; failing.*");
  assert.deepEqual(blocks, [
    { type: "section", text: { type: "mrkdwn", text: [
      text,
      "*Root cause (likely):* pay-db ran out of connections.",
      "*Policy:* Errors",
      "*Started:* 10:02 UTC",
      "*Status:* stopped (last error at 10:09 UTC)",
      "• *pay-api* `/pay`: 40 × Timeout. Pay fails. Funnel: Checkout",
      "• `/cart`: 1 × &lt;Err&gt;",
      "*Seen before:* No.",
    ].join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn", text: 'monitor "Errors &lt;prod&gt;" · Jan 1, 12:00 AM UTC' }] },
  ]);
});

test("monitorAlert without a summary posts the no-root-cause fallback", () => {
  const { text } = monitorAlert({ name: "m", triggeredAt: 0, summary: null, finding: null, timeZone: "UTC" });
  assert.match(text, /Monitor "m" fired; no root cause found/);
});

test("monitorAlert stays under Slack's section limit", () => {
  const long = "x".repeat(400);
  const s = summary({ issues: Array.from({ length: 5 }, () => issue(long, long, long, long, long)), seenBefore: long });
  const section = monitorAlert({ name: "m", triggeredAt: 0, summary: s, finding: finding({ headline: long, details: long.repeat(2) }), timeZone: "UTC" }).blocks[0] as { text: { text: string } };
  assert.ok(section.text.text.length <= 3000);
});

test("verdictOf redacts before clipping", () => {
  const service = verdictOf(summary({ issues: [issue(`${"x".repeat(290)} jo.doe@corp.com`, "", "")] }), null).issues[0][0];
  assert.ok(service.endsWith("[email]"), service);
});

test("monitorAlert always keeps the Action line and skips mentions when no ping is needed", () => {
  const alert = (ping?: boolean, action = "Acked and closed in New Relic: Errors on /pay <x> by jo@corp.com") => monitorAlert({
    name: "m", triggeredAt: 0, timeZone: "UTC", mentions: "U0123ABCD", ping,
    summary: summary({ policy: "Errors", issues: [issue("api", "/pay", "1 × Timeout")] }),
    finding: finding({ kind: "summary", headline: "Noise." }),
    action,
  });
  const { blocks } = alert(false);
  assert.deepEqual(blocks[0], { type: "section", text: { type: "mrkdwn", text: [
    "*[LOW :large_green_circle:] Noise.*", "*Policy:* Errors", "• *api* `/pay`: 1 × Timeout",
    "*Action:* Acked and closed in New Relic: Errors on /pay &lt;x&gt; by [email]",
  ].join("\n") } });
  assert.equal((blocks[1] as { type: string }).type, "context");
  const long = (alert(false, "<".repeat(3000)).blocks[0] as { text: { text: string } }).text.text;
  assert.ok(long.length <= 3000 && long.startsWith("*[LOW :large_green_circle:] Noise.*") && long.endsWith(" …"), String(long.length));
  assert.ok(alert(true).text.startsWith("<@U0123ABCD> "));
  assert.ok(alert().text.startsWith("<@U0123ABCD> "));
});

test("triageUpdate names the alert it follows up on, mentions only on ping", () => {
  assert.equal(
    triageUpdate({ name: "Errors", action: "Acked and closed: x", ping: false, firedAt: "Oct 1, 1:51 PM PDT", alert: "Apdex <0.95 for jane@x.com" }).text,
    "*Errors* · follow-up on the Oct 1, 1:51 PM PDT alert\nApdex &lt;0.95 for [email]\n*Action:* Acked and closed: x",
  );
  assert.equal(triageUpdate({ name: "Errors", action: "Closed in New Relic: High <rate>", ping: false, mentions: "U0123ABCD" }).text, "*Errors*\n*Action:* Closed in New Relic: High &lt;rate&gt;");
  assert.equal(triageUpdate({ name: "Errors", action: "Left open (still ongoing after 24h): x", ping: true, mentions: "@here" }).text, "<!here> *Errors*\n*Action:* Left open (still ongoing after 24h): x");
});

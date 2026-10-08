import { test } from "node:test";
import assert from "node:assert/strict";
import { isSlackWebhook, monitorAlert, parseMentions, postSlack, recheckUpdate, redact, triageUpdate, verdictOf } from "./slack.js";
import type { Finding } from "@tracer-sh/shared";
import type { AlertSummary } from "../monitors/alert-summary.js";

const issue = (service: string, endpoint: string, errors: string, userImpact = "", journeyStep = "") => ({ service, endpoint, errors, userImpact, journeyStep });
const finding = (f: Partial<Finding> = {}): Finding => ({ kind: "root_cause", headline: "", confidence: "likely", ...f });
const summary = (s: Partial<AlertSummary>): AlertSummary => ({
  severity: "low", policy: "", started: "", status: "", issues: [], ...s,
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
    }), finding({ headline: "**DB** timeouts after the 1.2 deploy.", cause: "Pool size dropped to 5 in 1.2.", confidence: undefined })),
    {
      severity: "high",
      summary: "DB timeouts after the 1.2 deploy.",
      verdict: "",
      happened: "",
      cause: "Pool size dropped to 5 in 1.2.",
      confidence: "unverified",
      facts: [["Policy", "Errors"]],
      issues: [["pay-api", "/pay", "3 × Timeout", "", "Checkout"], ["", "/cart", "1 × Timeout", "", ""]],
    },
  );
  assert.deepEqual(verdictOf(null, null), { severity: "unknown", summary: "", verdict: "", happened: "", cause: "", confidence: "", facts: [], issues: [] });
});

test("verdictOf takes the headline, verdict, happened, cause and confidence from the finding", () => {
  const v = verdictOf(null, finding({ headline: "Pool exhausted.", verdict: "no_problem", happened: "The pool held 50 of 50.", cause: "A burst at 10:05.", confidence: "confirmed" }));
  assert.deepEqual([v.summary, v.verdict, v.happened, v.cause, v.confidence], ["Pool exhausted.", "no problem", "The pool held 50 of 50.", "A burst at 10:05.", "confirmed"]);
  const s = verdictOf(summary({ severity: "high" }), finding({ kind: "summary", headline: "Checkout is healthy.", details: "Errors stayed at 0.2%.", confidence: undefined }));
  assert.deepEqual([s.severity, s.summary, s.happened, s.cause], ["high", "Checkout is healthy.", "", ""]);
});

test("redact masks personal data, keeps normal text", () => {
  assert.equal(
    redact("jo.d+x@corp.com 123-45-6789 (415) 555-1234 loan 1234567890 at 10:05 in svc-a v1.2"),
    "[email] [ssn] [phone] loan at 10:05 in svc-a v1.2",
  );
  assert.equal(
    redact("GET /api/loans/7?token=abc&x=1 by 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f"),
    "GET /api/loans by",
  );
  assert.equal(redact("yes, 08:30 PDT (session 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f), same cause"), "yes, 08:30 PDT, same cause");
  assert.equal(redact("card 4111 1111 1111 1111 on /v1/loans/12345678/pay at 9/29"), "card on /v1/loans/pay at 9/29");
});

test("redact removes links, ids and step citations without placeholders", () => {
  assert.equal(redact("see <https://nr.example/x?id=1|the chart> and https://a.example/b, <https://c.example>."), "see the chart and.");
  assert.equal(redact("Pool full [step 3] since 10:05 [steps 2, 4]"), "Pool full since 10:05");
  assert.equal(redact("incident 4821001234 (id 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f) closed"), "incident (id) closed");
});

test("a finding and summary with a URL, UUID, long id and step citation post none of them", () => {
  const dirty = "incident 4821001234 https://nr.example/i/1 3f2b1c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f [step 3]";
  const { blocks, text } = monitorAlert({
    name: "m", triggeredAt: 0, timeZone: "UTC",
    summary: summary({ policy: dirty, issues: [issue("api", "/pay", dirty)] }),
    finding: finding({ headline: `Pool full ${dirty}`, details: `Cause ${dirty}` }),
    action: `Left open ${dirty}`,
  });
  const all = JSON.stringify([text, blocks]);
  assert.doesNotMatch(all, /https?:|4821001234|3f2b1c9e|step 3|\[id\]|\[number\]|\{id\}|\[query\]/);
  assert.match(all, /Pool full/);
});

test("monitorAlert builds one compact section and a footer, escapes", () => {
  const { text, blocks } = monitorAlert({
    name: "Errors <prod>",
    triggeredAt: 1_767_225_600,
    summary: summary({
      severity: "high", policy: "Errors", started: "10:02 UTC",
      status: "stopped (last error at 10:09 UTC)", issues: [issue("pay-api", "/pay", "40 × Timeout", "Pay fails", "Checkout"), issue("unknown", "/cart", "1 × <Err>")],
    }),
    finding: finding({ headline: "Checkout is down & failing.", verdict: "problem", happened: "pay-api failed 40 requests.", cause: "pay-db ran out of connections [step 3]." }),
    timeZone: "UTC",
    mentions: "U0123ABCD",
  });
  assert.equal(text, "<@U0123ABCD> *[HIGH :red_circle: · problem] Checkout is down &amp; failing.*");
  assert.deepEqual(blocks, [
    { type: "section", text: { type: "mrkdwn", text: [
      text,
      "*What happened:* pay-api failed 40 requests.",
      "*Why (likely):* pay-db ran out of connections.",
      "*Policy:* Errors",
      "*Started:* 10:02 UTC",
      "*Status:* stopped (last error at 10:09 UTC)",
      "• *pay-api* `/pay`: 40 × Timeout. Pay fails. Funnel: Checkout",
      "• `/cart`: 1 × &lt;Err&gt;",
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
  const s = summary({ issues: Array.from({ length: 5 }, () => issue(long, long, long, long, long)) });
  const section = monitorAlert({ name: "m", triggeredAt: 0, summary: s, finding: finding({ headline: long, happened: long.repeat(2), cause: long.repeat(2) }), timeZone: "UTC" }).blocks[0] as { text: { text: string } };
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

test("triageUpdate states the alert and the action, with no reference to an earlier alert", () => {
  const text = triageUpdate({ name: "Errors", action: "Acked and closed: x", ping: false, alert: "Apdex <0.95 for jane@x.com" }).text;
  assert.equal(text, "*Errors*\nApdex &lt;0.95 for [email]\n*Action:* Acked and closed: x");
  assert.doesNotMatch(text, /follow-up on|earlier/);
  assert.equal(triageUpdate({ name: "Errors", action: "Closed in New Relic: High <rate>", ping: false, mentions: "U0123ABCD" }).text, "*Errors*\n*Action:* Closed in New Relic: High &lt;rate&gt;");
  assert.equal(triageUpdate({ name: "Errors", action: "Left open (still ongoing after 24h): x", ping: true, mentions: "@here" }).text, "<!here> *Errors*\n*Action:* Left open (still ongoing after 24h): x");
});

test("recheckUpdate is stateless, pings only when asked, and a report without Slack fields still renders", () => {
  const post = recheckUpdate({ name: "M", headline: "Pool exhausted.", state: "ongoing", action: "Left open", ping: true, mentions: "@here" });
  assert.equal(post.text, "<!here> *M*\nRe-check: Pool exhausted. State: ongoing.\n*Action:* Left open");
  assert.doesNotMatch(recheckUpdate({ name: "M", headline: "", ping: false, mentions: "@here" }).text, /<!here>/);
  assert.equal(verdictOf({ severity: "low", state: "resolved" }, null).issues.length, 0);
});

test("redact removes bare domain links and keeps file names, decimals and sentences", () => {
  assert.equal(redact("see nr.example.com/x/y?id=1 and docs.corp.io/a for details"), "see and for details");
  assert.equal(redact("Edited app.ts and config.json, latency 1.5 on v1.2. Done.Next step"), "Edited app.ts and config.json, latency 1.5 on v1.2. Done.Next step");
  assert.equal(redact("route /api/users.list/1 and src/app.ts/x"), "route /api/users.list/1 and src/app.ts/x");
});

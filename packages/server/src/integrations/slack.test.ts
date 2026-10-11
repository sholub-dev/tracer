import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, isSlackWebhook, known, monitorAlert, parseMentions, postSlack, recheckUpdate, redact, triageUpdate, verdictOf } from "./slack.js";
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
    }), finding({ headline: "**DB** timeouts after the 1.2 deploy.", confidence: undefined })),
    {
      severity: "high",
      summary: "DB timeouts after the 1.2 deploy.",
      verdict: "",
      confidence: "",
      facts: { policy: "Errors", started: "", status: "" },
      issues: [["pay-api", "/pay", "3 × Timeout", "", "Checkout"], ["", "/cart", "1 × Timeout", "", ""]],
      evidence: [],
    },
  );
  assert.deepEqual(verdictOf(null, null), { severity: "unknown", summary: "", verdict: "", confidence: "", facts: { policy: "", started: "", status: "" }, issues: [], evidence: [] });
});

test("known hides none, unknown and n/a with any suffix", () => {
  assert.equal(known("none (background analytics config failure)"), "");
  assert.equal(known("None"), "");
  assert.equal(known("Unknown."), "");
  assert.equal(known("n/a"), "");
  assert.equal(known("Checkout"), "Checkout");
  assert.equal(known("nonexistent route"), "nonexistent route");
});

test("verdictOf takes the headline, verdict and confidence from a root-cause card only", () => {
  const v = verdictOf(null, finding({ headline: "Pool exhausted.", verdict: "no_problem", confidence: "confirmed" }));
  assert.deepEqual([v.summary, v.verdict, v.confidence], ["Pool exhausted.", "no problem", "confirmed"]);
  const s = verdictOf(summary({ severity: "high" }), finding({ kind: "summary", headline: "Checkout is healthy.", details: "Errors stayed at 0.2%.", confidence: "confirmed" }));
  assert.deepEqual([s.severity, s.summary, s.confidence], ["high", "Checkout is healthy.", ""]);
});

test("verdictOf shows card facts only when the alert lists no issues", () => {
  const card = finding({ verdict: "problem", evidence: [{ fact: "**50 of 50** held for jo.d@corp.com" }, { fact: "b" }, { fact: "c" }, { fact: "d" }] });
  assert.deepEqual(verdictOf(summary({}), card).evidence, ["50 of 50 held for [email]", "b", "c"]);
  assert.deepEqual(verdictOf(summary({ issues: [issue("api", "/pay", "1 × Timeout")] }), card).evidence, []);
  assert.deepEqual(verdictOf(summary({}), finding({ kind: "summary", headline: "h", points: ["p1", "p2"] })).evidence, ["p1", "p2"]);
});

test("clip cuts at a word boundary and hard-cuts when there is no space", () => {
  assert.equal(clip("Left open, re-check set for later", 20), "Left open, re-check …");
  assert.equal(clip("x".repeat(30), 10), `${"x".repeat(10)} …`);
  assert.equal(clip("short", 10), "short");
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
      status: "stopped at 10:09 UTC", issues: [issue("pay-api", "/pay", "40 × Timeout", "Pay fails", "Checkout"), issue("none (background)", "/cart", "1 × <Err>", "none (background)", "none")],
    }),
    finding: finding({ headline: "Checkout is down & failing.", verdict: "problem", confidence: "confirmed" }),
    timeZone: "UTC",
    mentions: "U0123ABCD",
  });
  assert.equal(text, "<@U0123ABCD> *[HIGH :red_circle: · problem · confirmed] Checkout is down &amp; failing.*");
  assert.deepEqual(blocks, [
    { type: "section", text: { type: "mrkdwn", text: [
      text,
      "• *pay-api* `/pay`: 40 × Timeout. Pay fails. Funnel: Checkout",
      "• `/cart`: 1 × &lt;Err&gt;",
      "*Errors* · started 10:02 UTC · stopped at 10:09 UTC",
    ].join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn", text: 'monitor "Errors &lt;prod&gt;" · Jan 1, 12:00 AM UTC' }] },
  ]);
});

test("monitorAlert renders a full alert short, at most 3 issues and the action", () => {
  const { blocks } = monitorAlert({
    name: "Mobile Apdex", triggeredAt: 0, timeZone: "UTC",
    summary: summary({
      severity: "low", policy: "Mobile APDEX (Tier MID)", started: "22:14 PDT", status: "ongoing",
      issues: [
        issue("ContentSquare", "/android/config/v2/{app}.json", "23 × HTTP 404", "none (background analytics config failure)", "none (background)"),
        issue("Firebase", "/v1/projects/{id}/installations/{id}/authTokens:generate", "21 × network failure", "none", "none"),
        issue("Crashlytics", "/spi/v2/platforms/android/gmp/{id}/settings", "5 × network failure", "unknown", "n/a"),
      ],
    }),
    finding: finding({ headline: "Mobile Apdex dipped to 0.71 because third-party SDK errors weighed heavily at low traffic (19 requests in 10 min).", verdict: "no_problem", confidence: "confirmed" }),
    action: "Left open, re-check set",
  });
  const text = (blocks[0] as { text: { text: string } }).text.text;
  assert.equal(text, [
    "*[LOW :large_green_circle: · no problem · confirmed] Mobile Apdex dipped to 0.71 because third-party SDK errors weighed heavily at low traffic (19 requests in 10 min).*",
    "• *ContentSquare* `/android/config/v2/{app}.json`: 23 × HTTP 404",
    "• *Firebase* `/v1/projects/{id}/installations/{id}/authTokens:generate`: 21 × network failure",
    "• *Crashlytics* `/spi/v2/platforms/android/gmp/{id}/settings`: 5 × network failure",
    "*Mobile APDEX (Tier MID)* · started 22:14 PDT · ongoing",
    "*Action:* Left open, re-check set",
  ].join("\n"));
  assert.ok(text.length < 700, String(text.length));
});

test("monitorAlert shows 3 issues then +N more, and card facts when there are no issues", () => {
  const many = summary({ issues: Array.from({ length: 5 }, (_, i) => issue(`svc${i}`, "/p", "1 × E")) });
  const text = (monitorAlert({ name: "m", triggeredAt: 0, timeZone: "UTC", summary: many, finding: null }).blocks[0] as { text: { text: string } }).text.text;
  assert.equal(text.split("\n").filter((l) => l.startsWith("• ")).length, 3);
  assert.match(text, /\n\+2 more/);
  const none = monitorAlert({ name: "m", triggeredAt: 0, timeZone: "UTC", summary: summary({}), finding: finding({ verdict: "problem", evidence: [{ fact: "Errors rose to 5%" }] }) }).blocks[0] as { text: { text: string } };
  assert.match(none.text.text, /\n• Errors rose to 5%$/);
});

test("monitorAlert without a summary posts the no-root-cause fallback", () => {
  const { text } = monitorAlert({ name: "m", triggeredAt: 0, summary: null, finding: null, timeZone: "UTC" });
  assert.match(text, /Monitor "m" fired; no root cause found/);
});

test("monitorAlert stays under Slack's section limit", () => {
  const long = "x".repeat(400);
  const s = summary({ issues: Array.from({ length: 5 }, () => issue(long, long, long, long, long)) });
  const section = monitorAlert({ name: "m", triggeredAt: 0, summary: s, finding: finding({ headline: long, evidence: [{ fact: long }] }), timeZone: "UTC" }).blocks[0] as { text: { text: string } };
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
    "*[LOW :large_green_circle:] Noise.*", "• *api* `/pay`: 1 × Timeout", "*Errors*",
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

test("verdictOf shows the card evidence when no alert details were reported", () => {
  const v = verdictOf(null, finding({ headline: "Pool full.", verdict: "problem", confidence: "likely", evidence: [{ fact: "Pool held **50 of 50** at 10:05" }] }));
  assert.deepEqual(v.evidence, ["Pool held 50 of 50 at 10:05"]);
});

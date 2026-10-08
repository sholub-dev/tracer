import { eq } from "drizzle-orm";
import type { Db } from "../db/driver.js";
import { appSettings } from "../db/schema.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { formatLocalTime } from "../lib/current-context.js";
import type { Finding } from "@tracer-sh/shared";
import { type AlertSummary } from "../monitors/alert-summary.js";
import { readAppSetting, writeAppSetting } from "../db/config-reader.js";

export const SLACK_CONFIG_KEY = "integration:slack";

export interface SlackConfig {
  webhookUrl: string;
  /** Raw Settings input, e.g. "U0123ABCD, @here". */
  mentions?: string;
}

export function readSlackConfig(db: Db): Promise<SlackConfig | null> {
  return readAppSetting<SlackConfig>(db, SLACK_CONFIG_KEY);
}

export async function writeSlackConfig(db: Db, config: SlackConfig): Promise<void> {
  await writeAppSetting(db, SLACK_CONFIG_KEY, config);
}

export async function deleteSlackConfig(db: Db): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, SLACK_CONFIG_KEY)).run();
}

// Only Slack's webhook host, so a saved URL can't make the server post elsewhere.
export function isSlackWebhook(url: string): boolean {
  return url.startsWith("https://hooks.slack.com/services/");
}

export interface SlackPayload {
  text: string;
  blocks?: object[];
}

export async function postSlack(webhookUrl: string, payload: SlackPayload): Promise<{ ok: true } | { error: string }> {
  if (!isSlackWebhook(webhookUrl)) return { error: "Webhook URL must start with https://hooks.slack.com/services/" };
  try {
    // A retry after a lost response can post twice; that beats a lost alert.
    const res = await fetchWithRetry(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, { timeoutMs: 10_000 });
    if (!res.ok) return { error: `Slack returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SUMMARY_MAX_CHARS = 300;

// Slack is outside Tracer's access controls and a post must not point anywhere: ids, links and step citations are removed, and personal data is masked.
export function redact(text: string): string {
  return text
    .replace(/<https?:\/\/[^|>\s]*\|([^>]*)>/g, "$1")
    .replace(/<https?:\/\/[^>\s]*>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    // A bare host needs a slash after the TLD, so "app.ts", "v1.2" and "end.Next" stay.
    .replace(/(?<![\w/@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi, "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\s*\(?\bsession:?\s+[0-9a-f]{8}-[0-9a-f-]{27}\)?/gi, "")
    .replace(/\s*\[steps? [^\]]*\]/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/(\/[^\s?]*)\?\S+/g, "$1")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    .replace(/\+?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, "")
    .replace(/\b\d{9,}\b/g, "")
    .replace(/(?<=\/[A-Za-z][\w-]*)\/\d+\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

// Webhooks can't resolve names, so Slack only notifies for member/group IDs and @here/@channel.
export function parseMentions(input: string): { mentions: string[] } | { error: string } {
  const mentions: string[] = [];
  for (const raw of input.split(/[\s,]+/).filter(Boolean)) {
    const t = raw.replace(/^@/, "");
    if (t === "here" || t === "channel") mentions.push(`<!${t}>`);
    else if (/^[UW][A-Z0-9]{6,}$/.test(t)) mentions.push(`<@${t}>`);
    else if (/^S[A-Z0-9]{6,}$/.test(t)) mentions.push(`<!subteam^${t}>`);
    else return { error: `"${raw}" is not a Slack member ID. In Slack open the profile, then More (...), then Copy member ID (e.g. U0123ABCD).` };
  }
  return { mentions };
}

export function mentionPrefix(mentions: string[]): string {
  return mentions.length > 0 ? `${mentions.join(" ")} ` : "";
}

const DETAIL_MAX_CHARS = 300;
const ROOT_CAUSE_MAX_CHARS = 600;
const MAX_ISSUES = 5;
const SEVERITY_DOTS: Record<string, string> = { high: ":red_circle:", medium: ":large_orange_circle:", low: ":large_green_circle:" };
const SECTION_MAX_CHARS = 2900; // Slack rejects section text over 3000.

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} …` : s);
// Redact before clipping: a cut value may no longer match the redact patterns.
const tidy = (s: string, max = DETAIL_MAX_CHARS) => clip(redact(s.replace(/\*\*|`/g, "").replace(/^[ \t]*[-*][ \t]+/gm, "• ").trim()), max);
const known = (s: string) => (/^(unknown|n\/a|none)?\.?$/i.test(s) ? "" : s);

export interface Verdict {
  severity: string;
  summary: string;
  /** "problem", "no problem", "unclear" or "" (summary cards and cards saved before verdicts). */
  verdict: string;
  /** What happened and why, from a root-cause card ("" otherwise). */
  happened: string;
  cause: string;
  confidence: string;
  facts: [string, string][];
  /** Each issue: service, endpoint, errors, user impact, journey step ("" when unknown). */
  issues: string[][];
}

/** The answer card and the reported alert details, redacted and clipped, with unknowns hidden. */
export function verdictOf(summary: AlertSummary | null, finding: Finding | null): Verdict {
  const field = (s: string, max?: number) => known(tidy(s, max));
  const card = finding?.kind === "root_cause" ? finding : null;
  const head = {
    summary: finding ? tidy(finding.headline, SUMMARY_MAX_CHARS) : "",
    verdict: card?.verdict?.replace("_", " ") ?? "",
    happened: card ? field(card.happened ?? "", ROOT_CAUSE_MAX_CHARS) : "",
    cause: card ? field(card.cause ?? "", ROOT_CAUSE_MAX_CHARS) : "",
    confidence: finding ? finding.confidence ?? "unverified" : "",
  };
  if (!summary) return { severity: "unknown", ...head, facts: [], issues: [] };
  return {
    severity: summary.severity,
    ...head,
    facts: ([["Policy", summary.policy], ["Started", summary.started], ["Status", summary.status]] as [string, string | undefined][])
      .map(([l, v]): [string, string] => [l, field(v ?? "")]).filter(([, v]) => v),
    issues: (summary.issues ?? []).map((i) => [i.service, i.endpoint, i.errors, i.userImpact, i.journeyStep].map((v) => field(v)))
      .filter((parts) => parts.some(Boolean)),
  };
}

export interface MonitorAlert {
  name: string;
  triggeredAt: number;
  summary: AlertSummary | null;
  finding: Finding | null;
  timeZone: string;
  mentions?: string;
  /** Triage outcome, shown after the facts. */
  action?: string;
  /** False when nothing needs a person; undefined keeps the mentions. */
  ping?: boolean;
}

function mentionsFor(raw: string | undefined, ping: boolean | undefined): string {
  if (ping === false) return "";
  const parsed = parseMentions(raw ?? "");
  return "mentions" in parsed ? mentionPrefix(parsed.mentions) : "";
}

function issueLine([service = "", endpoint = "", error = "", experience = "", funnel = ""]: string[]): string {
  const where = [service && `*${escape(service)}*`, endpoint && `\`${escape(endpoint)}\``].filter(Boolean).join(" ");
  const what = [error, experience].filter(Boolean).map(escape);
  if (funnel) what.push(`Funnel: ${escape(funnel)}`);
  return `• ${[where, what.join(". ")].filter(Boolean).join(": ")}`;
}

export function monitorAlert(a: MonitorAlert): Required<SlackPayload> {
  const time = formatLocalTime(a.triggeredAt, a.timeZone);
  const { severity, summary, verdict, happened, cause, confidence, facts, issues } = verdictOf(a.summary, a.finding);
  const mentions = mentionsFor(a.mentions, a.ping);
  const name = redact(a.name);
  const text = `${mentions}*[${[severity.toUpperCase(), SEVERITY_DOTS[severity], verdict && `· ${verdict}`].filter(Boolean).join(" ")}] ${escape(summary || `Monitor "${name}" fired; no root cause found`)}*`;
  const lines = [text];
  if (happened) lines.push(`*What happened:* ${escape(happened)}`);
  if (cause) lines.push(`*Why (${confidence}):* ${escape(cause)}`);
  lines.push(...facts.map(([l, v]) => `*${l}:* ${escape(v)}`));
  lines.push(...issues.slice(0, MAX_ISSUES).map(issueLine));
  if (issues.length > MAX_ISSUES) lines.push(`+${issues.length - MAX_ISSUES} more`);
  const action = a.action ? clip(`*Action:* ${escape(redact(a.action))}`, SECTION_MAX_CHARS / 2) : "";
  const room = SECTION_MAX_CHARS - (action ? action.length + 1 : 0);
  // Drop whole lines, not mid-span, so Slack formatting stays closed; the action line always fits.
  while (lines.length > 1 && lines.join("\n").length > room) lines.pop();
  if (action) lines.push(action);
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn", text: escape(`monitor "${name}" · ${time}`) }] },
    ],
  };
}

/** Post for a triage outcome; `alert` is the headline of the alert it covers. */
export function triageUpdate(u: { name: string; action: string; ping: boolean; mentions?: string; alert?: string }): SlackPayload {
  const head = `${mentionsFor(u.mentions, u.ping)}*${escape(redact(u.name))}*`;
  const alert = u.alert ? escape(tidy(u.alert, SUMMARY_MAX_CHARS)) : "";
  const prefix = [head, alert, "*Action:* "].filter(Boolean).join("\n");
  // Clip after escaping: entities lengthen the text past Slack's section limit.
  const text = prefix + clip(escape(redact(u.action)), SECTION_MAX_CHARS - prefix.length);
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

/** Post for a re-check of an alert; the text names no earlier post. */
export function recheckUpdate(u: { name: string; headline: string; state?: string; action?: string; ping: boolean; mentions?: string }): SlackPayload {
  const head = `${mentionsFor(u.mentions, u.ping)}*${escape(redact(u.name))}*`;
  const headline = u.headline ? escape(tidy(u.headline, SUMMARY_MAX_CHARS)) : "";
  const check = `${[`Re-check${headline ? `: ${headline.replace(/[.\s]+$/, "")}` : ""}`, u.state && `State: ${u.state}`].filter(Boolean).join(". ")}.`;
  const lines = [head, check, u.action && `*Action:* ${escape(redact(u.action))}`].filter(Boolean) as string[];
  const text = clip(lines.join("\n"), SECTION_MAX_CHARS);
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import { readAppSetting, writeAppSetting } from "../db/config-reader.js";

export const SLACK_CONFIG_KEY = "integration:slack";

export interface SlackConfig {
  webhookUrl: string;
  /** Raw Settings input, e.g. "U0123ABCD, @here". */
  mentions?: string;
}

export function readSlackConfig(db: Db): SlackConfig | null {
  return readAppSetting<SlackConfig>(db, SLACK_CONFIG_KEY);
}

export function writeSlackConfig(db: Db, config: SlackConfig): void {
  writeAppSetting(db, SLACK_CONFIG_KEY, config);
}

export function deleteSlackConfig(db: Db): void {
  db.delete(appSettings).where(eq(appSettings.key, SLACK_CONFIG_KEY)).run();
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
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: `Slack returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const SUMMARY_MAX_CHARS = 300;

// Slack is outside Tracer's access controls: mask emails, SSNs, phone-like and long numbers, card numbers and path IDs; drop session references.
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\s*\(?\bsession:?\s+[0-9a-f]{8}-[0-9a-f-]{27}\)?/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/(\/[^\s?]*)\?\S+/g, "$1?[query]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    .replace(/\+?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, "[number]")
    .replace(/\b\d{9,}\b/g, "[number]")
    .replace(/(?<=\/[A-Za-z][\w-]*\/)\d+\b/g, "{id}");
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
const MAX_ISSUES = 5;
const SECTION_MAX_CHARS = 2900; // Slack rejects section text over 3000.
const FACT_LABELS = ["Policy", "Started", "Status"];

export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} …` : s);
// Redact before clipping: a cut value may no longer match the redact patterns.
const tidy = (s: string, max = DETAIL_MAX_CHARS) => clip(redact(s.replace(/\*\*|`/g, "").trim()), max);
const known = (s: string) => (/^(unknown|n\/a|none)?\.?$/i.test(s) ? "" : s);
const labelLines = (text: string, label: string) =>
  [...text.matchAll(new RegExp(`^\\W*${label}\\**\\s*:\\**\\s*(.+)$`, "gim"))].map((m) => m[1]);
const lastLine = (text: string, label: string) => known(tidy(labelLines(text, label).at(-1) ?? ""));

export interface Verdict {
  severity: string;
  summary: string;
  facts: [string, string][];
  /** Each issue: service, endpoint, error, user experience, funnel step ("" when unknown). */
  issues: string[][];
  seenBefore: string;
}

/** Reads the agent's closing "Severity:", "TL;DR:", fact and "Issue:" lines, redacted; falls back to the first sentence. */
export function parseVerdict(analysis: string): Verdict {
  const severities = [...analysis.matchAll(/^\W*severity\W*(critical|high|medium|low)\b/gim)];
  const severity = severities.at(-1)?.[1]?.toLowerCase() ?? "unknown";
  let summary = labelLines(analysis, "tl;?dr").at(-1) ?? "";
  if (!summary) {
    const prose = analysis.split("\n").find((l) => /[a-z]/i.test(l) && !/^\s*(#|```|\||severity)/i.test(l)) ?? "";
    summary = prose.split(/(?<=[.!?])\s/)[0] ?? "";
  }
  const facts = FACT_LABELS.map((l): [string, string] => [l, lastLine(analysis, l)]).filter(([, v]) => v);
  // Only the closing block when there is one, so "Issue:" lines in the body are ignored.
  const closing = analysis.slice(severities.at(-1)?.index ?? 0);
  const issues = labelLines(closing, "issue")
    .map((line) => line.split("|").map((p) => known(tidy(p))))
    .filter((parts) => parts.some(Boolean));
  return { severity, summary: tidy(summary, SUMMARY_MAX_CHARS), facts, issues, seenBefore: lastLine(analysis, "Seen before") };
}

export interface MonitorAlert {
  name: string;
  triggeredAt: number;
  analysis: string;
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
  const time = new Date(a.triggeredAt * 1000).toLocaleString("en-US", {
    timeZone: a.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const { severity, summary, facts, issues, seenBefore } = parseVerdict(a.analysis);
  const mentions = mentionsFor(a.mentions, a.ping);
  const name = redact(a.name);
  const text = `${mentions}*[${severity.toUpperCase()}] ${escape(summary || `Monitor "${name}" fired; no root cause found`)}*`;
  const lines = [text];
  if (facts.length > 0) lines.push(facts.map(([l, v]) => `*${l}:* ${escape(v)}`).join("  ·  "));
  lines.push(...issues.slice(0, MAX_ISSUES).map(issueLine));
  if (issues.length > MAX_ISSUES) lines.push(`+${issues.length - MAX_ISSUES} more`);
  if (seenBefore) lines.push(`*Seen before:* ${escape(seenBefore)}`);
  // Drop whole lines, not mid-span, so Slack formatting stays closed.
  while (lines.length > 1 && lines.join("\n").length > SECTION_MAX_CHARS) lines.pop();
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ...(a.action ? [{ type: "section", text: { type: "mrkdwn", text: clip(`*Action:* ${escape(redact(a.action))}`, SECTION_MAX_CHARS) } }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: escape(`monitor "${name}" · ${time}`) }] },
    ],
  };
}

/** One-line post for a triage re-check outcome. */
export function triageUpdate(u: { name: string; action: string; ping: boolean; mentions?: string }): SlackPayload {
  const prefix = `${mentionsFor(u.mentions, u.ping)}*${escape(redact(u.name))}:* `;
  // Clip after escaping: entities lengthen the text past Slack's section limit.
  const text = prefix + clip(escape(redact(u.action)), SECTION_MAX_CHARS - prefix.length);
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

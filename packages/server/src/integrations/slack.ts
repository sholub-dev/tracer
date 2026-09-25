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

export async function postSlack(webhookUrl: string, text: string): Promise<{ ok: true } | { error: string }> {
  if (!isSlackWebhook(webhookUrl)) return { error: "Webhook URL must start with https://hooks.slack.com/services/" };
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
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
const MAX_GROUPS = 5;

// Slack is outside Tracer's access controls: mask emails, SSNs, phone-like and long numbers.
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    .replace(/\+?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]")
    .replace(/\b\d{9,}\b/g, "[number]");
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

/** Reads the agent's closing "Severity:" and "TL;DR:" lines; falls back to the first sentence. */
export function parseVerdict(analysis: string): { severity: string; summary: string } {
  const severity = [...analysis.matchAll(/^\W*severity\W*(critical|high|medium|low)\b/gim)].pop()?.[1]?.toLowerCase() ?? "unknown";
  let summary = [...analysis.matchAll(/^\W*tl;?dr\W*(.+)$/gim)].pop()?.[1] ?? "";
  if (!summary) {
    const prose = analysis.split("\n").find((l) => /[a-z]/i.test(l) && !/^\s*(#|```|\||severity)/i.test(l)) ?? "";
    summary = prose.split(/(?<=[.!?])\s/)[0] ?? "";
  }
  summary = summary.replace(/\*\*|`/g, "").trim();
  return { severity, summary: summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)} …` : summary };
}

export interface MonitorAlert {
  name: string;
  condition: string;
  value: number;
  groups: string[];
  triggeredAt: number;
  analysis: string;
  timeZone: string;
  mentions?: string;
}

export function monitorAlertText(a: MonitorAlert): string {
  const time = new Date(a.triggeredAt * 1000).toLocaleString("en-US", {
    timeZone: a.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const { severity, summary } = parseVerdict(a.analysis);
  const parsed = parseMentions(a.mentions ?? "");
  const headline = redact(summary) || `Monitor "${a.name}" fired; no root cause found`;
  const lines = [`${"mentions" in parsed ? mentionPrefix(parsed.mentions) : ""}*[${severity.toUpperCase()}] ${escape(headline)}*`];
  const keys = a.groups.filter(Boolean).map(redact);
  const more = keys.length > MAX_GROUPS ? ` +${keys.length - MAX_GROUPS} more` : "";
  if (keys.length > 0) lines.push(`Affected: ${escape(keys.slice(0, MAX_GROUPS).join(", "))}${more}`);
  lines.push(`_Found by monitor "${escape(a.name)}" (count ${a.value}, condition ${escape(a.condition)}) at ${time}_`);
  return lines.join("\n");
}

import { z } from "zod";
import { tool, type Tool, type UIMessage } from "ai";
import { findingFromMessages, type Finding } from "@tracer-sh/shared";

/** Slack posts are stateless: the text may carry no id, link or reference to anything else. */
export const SLACK_RULE = "This text is posted to Slack as written: state facts about this alert only. No ids, no links, no references to other alerts, earlier posts, sessions, investigation steps, past occurrences or tickets.";

export const SEVERITIES = ["high", "medium", "low"] as const;
export const ALERT_STATES = ["ongoing", "resolved", "unclear"] as const;

export const MONITOR_ROLE = "You own this alert until it is resolved. If the data up to now shows it stopped: close it when your close tools are listed, otherwise state it stopped. If it is ongoing: call set_timer to check again; choose the interval from the impact (shorter when users are affected). On each re-check, look at the data since the last check, then resolve or set the next timer.";

/** The step that reports the alert; Slack posts the details only when Slack is connected. */
export function summaryInstruction(slack: boolean): string {
  return slack
    ? " Right after it, before any visual, call report_alert_summary once with the alert details (after report_issue_status when that tool is listed). Slack posts the card and the details together. Do not repeat the card or the details as text. " + SLACK_RULE
    : " Right after it, before any visual, call report_alert_summary once with the severity and the state of the alert (after report_issue_status when that tool is listed).";
}

const baseFields = {
  severity: z.enum(SEVERITIES)
    .describe("high: outage, users blocked or a key flow degraded; medium: limited impact; low: noise or no user impact"),
  state: z.enum(ALERT_STATES)
    .describe("ongoing: errors in the latest minutes up to now; resolved: stopped; unclear: the data does not show it"),
};

const slackFields = {
  policy: z.string().describe("The name of the alert policy or condition that fired, never an id"),
  started: z.string().describe("The first bad minute in the data, with time zone"),
  status: z.string().describe("One of: stopped (last error at <time>); ongoing (errors in the latest minutes up to now); recurring (the repeat pattern, e.g. every hour since 06:00). Check the data up to now."),
  issues: z.array(z.object({
    service: z.string(),
    endpoint: z.string().describe("Route pattern such as /loans/{id}"),
    errors: z.string().describe("<count> × <error class and code> (<error rate>)"),
    userImpact: z.string().describe("What the user sees"),
    journeyStep: z.string().describe("User journey step, or \"none (background)\""),
  })).max(5).describe("One per endpoint, largest first"),
  notify: z.boolean().describe("Ping the people tagged in Slack: true when the impact needs a person now; on a re-check, true while it is still ongoing with user impact"),
};

// Saved reports can lack the Slack fields (no Slack when written) or the state (older sessions).
const savedSchema = z.object({
  severity: baseFields.severity,
  state: baseFields.state.optional(),
  policy: slackFields.policy.optional(),
  started: slackFields.started.optional(),
  status: slackFields.status.optional(),
  issues: slackFields.issues.optional(),
  notify: slackFields.notify.optional(),
});

export type AlertSummary = z.infer<typeof savedSchema>;

// Read back from the saved tool call: failed attempts are never saved, and it goes with the session.
export function reportAlertSummaryTool({ slack }: { slack: boolean }): Tool<AlertSummary, { recorded: true }> {
  return tool({
    description: "Report the state of this alert. Call it once, alone in its step, after report_finding (and after report_issue_status when that tool is present); a later call replaces it. "
      + "Check the data up to now for the state. "
      + (slack
        ? "Slack posts the alert details together with the answer card from report_finding. "
          + "Facts from query results only; write \"unknown\" when the data does not show it, never guess. "
          + "Name endpoints by route pattern, never raw URLs or IDs. No personal data such as emails, names or account numbers. "
          + "Never suggest fixes or actions, never add counts across endpoints, never mention sessions, session ids or Tracer. "
          + SLACK_RULE
        : ""),
    inputSchema: z.object(slack ? { ...baseFields, ...slackFields } : baseFields) as unknown as z.ZodType<AlertSummary>,
    execute: async () => ({ recorded: true }),
  });
}

export function dismissAlertTool(): Tool<{ reason: string }, { recorded: true }> {
  return tool({
    description: "End a firing whose New Relic incidents are all closed already. Nothing more is posted and no issue is acked or closed. "
      + "Call it only when a query result shows that every incident of this firing is closed.",
    inputSchema: z.object({
      reason: z.string().describe("The result that shows it, e.g. \"Every incident closed at 13:58\""),
    }),
    execute: async () => ({ recorded: true }),
  });
}

/** The reason of the last successful dismiss_alert call; null when none came after the last successful report_alert_summary. */
export function dismissalFromMessages(messages: UIMessage[]): string | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (!("state" in p) || p.state !== "output-available") continue;
      if (p.type === "tool-report_alert_summary") return null;
      if (p.type !== "tool-dismiss_alert") continue;
      const reason = (p.input as { reason?: unknown } | undefined)?.reason;
      return typeof reason === "string" ? reason : "";
    }
  }
  return null;
}

/** The input of the last successful report_alert_summary call whose input is valid. */
export function summaryFromMessages(messages: UIMessage[]): AlertSummary | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== "tool-report_alert_summary" || !("state" in p) || p.state !== "output-available") continue;
      const parsed = savedSchema.safeParse(p.input);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

/** Like summaryFromMessages, but only for the latest run: the parts after the last user message. */
export function latestRunSummary(messages: UIMessage[]): AlertSummary | null {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  return summaryFromMessages(messages.slice(lastUser + 1));
}

const isReport = (p: UIMessage["parts"][number]) => p.type === "tool-report_alert_summary" && "state" in p && p.state === "output-available";

/** The finding that goes with the alert details: a finding from a later follow-up turn must not replace it. */
export function alertFindingFromMessages(messages: UIMessage[]): Finding | null {
  let end = messages.length;
  while (end > 0 && !messages[end - 1].parts.some(isReport)) end--;
  return findingFromMessages(end > 0 ? messages.slice(0, end) : messages);
}

/** First prose sentence: the summary of a run that never reported one. */
export function firstSentence(analysis: string): string {
  const prose = analysis.split("\n").find((l) => /[a-z]/i.test(l) && !/^\s*(#|```|\|)/.test(l)) ?? "";
  return prose.split(/(?<=[.!?])\s/)[0] ?? "";
}

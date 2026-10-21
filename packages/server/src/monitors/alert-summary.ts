import { z } from "zod";
import { tool, type ModelMessage, type Tool, type UIMessage } from "ai";
import { cardRejected, findingFromMessages, turnStart, type Finding } from "@tracer-sh/shared";

/** Slack posts are stateless: the text may carry no id, link or reference to anything else. */
export const SLACK_RULE = "This text is posted to Slack as written: state facts about this alert only. No ids, no links, no references to other alerts, earlier posts, sessions, investigation steps, past occurrences or tickets.";

export const SEVERITIES = ["high", "medium", "low"] as const;
export const ALERT_STATES = ["ongoing", "resolved", "unclear"] as const;

export const MONITOR_ROLE = "You own this alert until it needs no more attention. In every run, investigate the cause as in any session: follow the chain into each service, database or host that the connected sources cover, also outside what this alert covers, until a result shows the mechanism or the data stops. On each re-check, look at the whole episode up to now and compare it with your earlier reports, not only the time since the last check. Check that your earlier cause still explains every symptom, and go deeper where it stopped short. Then decide whether to watch it longer. Resolved: the value is back to its normal level (the level before the spike) and stays there; say what ended it when the data shows it. Report resolved, and close the issues when your close tools are listed. Handed to a person: the problem is still present and later data cannot add evidence (it is stable, not worsening), or the next link of the cause is outside every connected source. Report ongoing, set no timer, and say why in the headline. Still changing: only then call set_timer, and choose the interval from how fast the value changes and the impact.";

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
    .describe("ongoing: the problem is present in the latest minutes, as errors or as a value outside its normal level; resolved: back to its normal level (the level before the spike) and staying there; unclear: the data does not show it"),
};

const slackFields = {
  policy: z.string().describe("The name of the alert policy or condition that fired, never an id"),
  started: z.string().describe("The first bad minute, time and time zone only, e.g. 22:14 PDT"),
  status: z.string().describe("One of: ongoing; back to normal at <time>; recurring <pattern, e.g. hourly since 06:00>; never left its normal level. At most 6 words. Check the data up to now."),
  issues: z.array(z.object({
    service: z.string(),
    endpoint: z.string().describe("Route pattern such as /loans/{id} or a GraphQL operation name, read from a result: the path without the transaction prefix and method. Empty for a service-wide value or when no result names one."),
    errors: z.string().describe("For errors: <count> × <error class or code> from the first bad minute to the status time, both from one result that counts this endpoint's errors by class, the class without its package (DataAccessResourceFailureException); when it shows several classes, name the largest with its own count. For latency or traffic: the value next to its normal level, e.g. 7.3s avg vs 0.08s normal."),
    userImpact: z.string().describe("For an error line: the failure status code or error message from the same result as the count, or exactly \"none\". For a latency or traffic line: exactly \"none\"."),
  })).max(5).describe("Up to 3, one per endpoint, largest first"),
  notify: z.boolean().describe("Ping the people tagged in Slack: true when the impact needs a person now, including a hand-over to a person; false on a re-check that found nothing new"),
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

export type SummaryReview = (summary: AlertSummary, messages: ModelMessage[], abortSignal: AbortSignal | undefined) => Promise<string | null>;
type SummaryOutput = { recorded: true } | { recorded: false; problems: string; next: string };

const NEXT = "The alert details are not posted. For each problem, fix the listed fields from the results: take a count and its error class from one result row, and a status code from the same result as the count. Then call report_alert_summary again with all fields.";

/** Slack tools made here: the run swaps in a reviewed one only for these. */
const slackSummaryTools = new WeakSet<object>();
export const isSlackSummaryTool = (t: unknown) => typeof t === "object" && t !== null && slackSummaryTools.has(t);

// One review: a summary sent back earlier in this turn is recorded as written, so a disagreement cannot loop.
// The count comes from the history, so a re-run attempt keeps it. `turnFrom` is the index of the turn's first message.
function wasSentBack(messages: ModelMessage[], turnFrom: number): boolean {
  return messages.slice(Math.max(0, turnFrom)).some((m) => m.role === "tool" && m.content.some((p) =>
    p.type === "tool-result" && p.toolName === "report_alert_summary" && cardRejected((p.output as { value?: unknown }).value)));
}

// Read back from the saved tool call: failed attempts are never saved, and it goes with the session.
export function reportAlertSummaryTool({ slack }: { slack: boolean }, review?: SummaryReview, turnFrom: () => number = () => 0): Tool<AlertSummary, SummaryOutput> {
  const t = tool({
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
    execute: async (summary, options): Promise<SummaryOutput> => {
      if (!slack || !review || wasSentBack(options.messages, turnFrom())) return { recorded: true };
      const problems = (await review(summary, options.messages, options.abortSignal))?.trim();
      return problems && !/^\W*OK\W*$/i.test(problems) ? { recorded: false, problems, next: NEXT } : { recorded: true };
    },
  });
  if (slack) slackSummaryTools.add(t);
  return t;
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
      if (p.type === "tool-report_alert_summary" && !cardRejected(p.output)) return null;
      if (p.type !== "tool-dismiss_alert") continue;
      const reason = (p.input as { reason?: unknown } | undefined)?.reason;
      return typeof reason === "string" ? reason : "";
    }
  }
  return null;
}

// A summary the review sent back was never posted.
const isReport = (p: UIMessage["parts"][number]): boolean => p.type === "tool-report_alert_summary" && "state" in p && p.state === "output-available" && !cardRejected(p.output);

/** The input of the last successful report_alert_summary call whose input is valid. */
export function summaryFromMessages(messages: UIMessage[]): AlertSummary | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (!isReport(p)) continue;
      const parsed = savedSchema.safeParse((p as { input?: unknown }).input);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

/** Like summaryFromMessages, but only for the latest run: the parts after the last user message. */
export function latestRunSummary(messages: UIMessage[]): AlertSummary | null {
  return summaryFromMessages(messages.slice(turnStart(messages)));
}


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

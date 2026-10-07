import { z } from "zod";
import { CONFIDENCE } from "@tracer-sh/shared";
import { tool, type Tool, type UIMessage } from "ai";

export const SEVERITIES = ["high", "medium", "low"] as const;

const alertSummarySchema = z.object({
  severity: z.enum(SEVERITIES)
    .describe("high: outage, users blocked or a key flow degraded; medium: limited impact; low: noise or no user impact"),
  tldr: z.string().describe("One sentence: what broke and its impact, with the key number. Not a restatement of the monitor."),
  rootCause: z.string().describe("Two or three sentences: why it happened, the chain from cause to errors, proven by query results."),
  confidence: z.enum(CONFIDENCE).optional().describe("confirmed: a query result shows the cause itself and eliminates the strongest alternative. likely: the data points to it. unverified: the data does not show it."),
  policy: z.string().describe("The alert policy or condition that fired"),
  started: z.string().describe("The first bad minute in the data, with time zone"),
  status: z.string().describe("One of: stopped (last error at <time>); ongoing (errors in the latest minutes up to now); recurring (the repeat pattern, e.g. every hour since 06:00). Check the data up to now."),
  issues: z.array(z.object({
    service: z.string(),
    endpoint: z.string().describe("Route pattern such as /loans/{id}"),
    errors: z.string().describe("<count> × <error class and code> (<error rate>)"),
    userImpact: z.string().describe("What the user sees"),
    journeyStep: z.string().describe("User journey step, or \"none (background)\""),
  })).max(5).describe("One per endpoint, largest first"),
  seenBefore: z.string().describe("yes or no; when it happened before and whether this run's data shows the same cause"),
});

export type AlertSummary = z.infer<typeof alertSummarySchema>;

// Read back from the saved tool call: failed attempts are never saved, and it goes with the session.
export function reportAlertSummaryTool(): Tool<AlertSummary, { recorded: true }> {
  return tool({
    description: "Report the alert summary that is posted to Slack. Call it once when the investigation is done; a later call replaces it. "
      + "Facts from query results only; write \"unknown\" when the data does not show it, never guess. "
      + "Name endpoints by route pattern, never raw URLs or IDs. No personal data such as emails, names or account numbers. "
      + "Never suggest fixes or actions, never add counts across endpoints, never mention sessions, session ids or Tracer.",
    inputSchema: alertSummarySchema,
    execute: async () => ({ recorded: true }),
  });
}

export function dismissAlertTool(): Tool<{ reason: string }, { recorded: true }> {
  return tool({
    description: "End a firing whose New Relic incidents are all closed already. Nothing is posted to Slack and no issue is acked or closed. "
      + "Call it only when a query result shows that every incident of this firing is closed.",
    inputSchema: z.object({
      reason: z.string().describe("The result that shows it, e.g. \"incident 4821 closed at 13:58\""),
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
      const parsed = alertSummarySchema.safeParse(p.input);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

/** First prose sentence: the summary of a run that never reported one. */
export function firstSentence(analysis: string): string {
  const prose = analysis.split("\n").find((l) => /[a-z]/i.test(l) && !/^\s*(#|```|\|)/.test(l)) ?? "";
  return prose.split(/(?<=[.!?])\s/)[0] ?? "";
}

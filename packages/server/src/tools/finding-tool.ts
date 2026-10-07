import { tool, type Tool } from "ai";
import { SESSION_KIND, findingSchema, type Finding, type SessionKind } from "@tracer-sh/shared";

// Read back from the saved tool call, like the alert summary.
export function reportFindingTool(): Tool<Finding, { recorded: true }> {
  return tool({
    description: "Show the answer as a card. The card is the whole written answer: call it once, alone in its step, in every turn that ran at least one query, after the investigation and before any supporting visuals. "
      + "Use kind root_cause when the turn explains why something happened, summary for status, counts, trends and lookups. Skip it only when no query ran. Facts from query results only; never a fix. You may state an action you performed in this turn as a fact.",
    inputSchema: findingSchema,
    execute: async () => ({ recorded: true }),
  });
}

/** Monitor runs report through report_alert_summary instead. */
export function findingTools(kind?: SessionKind): Record<string, unknown> {
  return kind === SESSION_KIND.MONITOR ? {} : { report_finding: reportFindingTool() };
}

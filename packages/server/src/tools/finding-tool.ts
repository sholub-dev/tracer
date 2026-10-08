import { tool, type Tool } from "ai";
import { findingSchema, type Finding } from "@tracer-sh/shared";

// Read back from the saved tool call, like the alert summary.
export function reportFindingTool(): Tool<Finding, { recorded: true }> {
  return tool({
    description: "Show the answer as a card. The card is the whole written answer: call it once, alone in its step, in every turn that ran at least one query, after the investigation and before any supporting visuals. "
      + "Use kind root_cause (with a verdict) when the turn explains why something happened, summary for status, counts, trends and lookups. Skip it only when no query ran. Facts from query results only; never a fix. You may state an action you performed in this turn as a fact. The headline is plain text; the other text fields take inline **bold** and `code`; happened, cause, impact and summary details may also hold a short list.",
    inputSchema: findingSchema,
    execute: async () => ({ recorded: true }),
  });
}

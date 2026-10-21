import { tool, type ModelMessage, type Tool } from "ai";
import { cardRejected, findingSchema, type Finding } from "@tracer-sh/shared";

export type CardReview = (card: Finding, messages: ModelMessage[], abortSignal: AbortSignal | undefined, earlierProblems: string[]) => Promise<string | null>;
type FindingOutput = { recorded: true } | { recorded: false; problems: string; next: string };

const NEXT = "The card is not shown. For each problem, run the query that settles it when a connected source holds the data; otherwise reword the claim, lower the confidence label or move the claim to gap. A number that repeats stays in the headline and leaves the other fields. Then call report_finding again with the whole card.";

// A full review, then a recheck of the rewritten card; the third card is recorded as written, so a disagreement cannot loop,
// unless it switched to a new answer: that one gets one last review.
// Only a card that was sent back counts, and it is counted from the history, so a re-run attempt keeps the count.
const REVIEWS = 2;

type SentBack = { problems: string; headline: string };

/** The cards the review sent back in this turn, oldest first. `turnFrom` is the index of the turn's first message. */
function sentBackCards(messages: ModelMessage[], turnFrom: number): SentBack[] {
  const headlines = new Map<string, string>();
  const out: SentBack[] = [];
  for (const m of messages.slice(Math.max(0, turnFrom))) {
    if (m.role === "assistant" && typeof m.content !== "string") {
      for (const p of m.content) if (p.type === "tool-call" && p.toolName === "report_finding") headlines.set(p.toolCallId, String((p.input as { headline?: unknown } | null)?.headline ?? ""));
    }
    if (m.role !== "tool") continue;
    for (const p of m.content) {
      if (p.type !== "tool-result" || p.toolName !== "report_finding") continue;
      const value = (p.output as { value?: unknown }).value;
      if (cardRejected(value)) out.push({ problems: String((value as { problems?: unknown }).problems ?? ""), headline: headlines.get(p.toolCallId) ?? "" });
    }
  }
  return out;
}

// Service names such as PROD-SVC-USER and `code` spans: what a headline is about.
const subjects = (headline: string) => new Set([...headline.matchAll(/`([^`]+)`|\b[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+\b/g)].map((m) => (m[1] ?? m[0]).toLowerCase()));

/** A card whose headline names none of the subjects of the last reviewed card is a new answer, and new answers get a review. */
function newAnswer(card: Finding, last: SentBack | undefined): boolean {
  const before = subjects(last?.headline ?? "");
  const now = subjects(card.headline);
  return before.size > 0 && now.size > 0 && ![...now].some((s) => before.has(s));
}

export function reportFindingTool(review?: CardReview, turnFrom: () => number = () => 0): Tool<Finding, FindingOutput> {
  return tool({
    description: "Show the answer as a card. The card is the whole written answer: call it once, alone in its step, in every turn that ran at least one query, after the investigation and before any supporting visuals. "
      + "Use kind root_cause (with a verdict) when the turn explains why something happened, summary for status, counts, trends and lookups. Skip it only when no query ran. Facts from query results only; never a fix. You may state an action you performed in this turn as a fact. The headline is plain text; the other text fields take inline **bold** and `code`; summary details may also hold a short list.",
    inputSchema: findingSchema,
    execute: async (card, options): Promise<FindingOutput> => {
      const sent = sentBackCards(options.messages, turnFrom());
      if (!review || sent.length > REVIEWS || (sent.length === REVIEWS && !newAnswer(card, sent.at(-1)))) return { recorded: true };
      const problems = (await review(card, options.messages, options.abortSignal, sent.map((c) => c.problems)))?.trim();
      return problems && !/^\W*OK\W*$/i.test(problems) ? { recorded: false, problems, next: NEXT } : { recorded: true };
    },
  });
}

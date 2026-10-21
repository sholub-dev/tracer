import { z } from "zod";
import { tool, type ModelMessage, type Tool } from "ai";
import { CONFIDENCE, TOOL_NAMES } from "@tracer-sh/shared";

const ledgerSchema = z.object({
  question: z.enum(["lookup", "status", "cause"]).describe("lookup = only a count, list or value, with no why in the question or in an earlier user message of this thread. status = a health or status check that found nothing wrong. cause = why something happens, or a check that found a problem."),
  chain: z.string().optional().describe("For a cause: each link from the symptom down to the deepest cause, in order. Write each link as what its result shows, with its number, then the exact title of that query in brackets. A reason (because, due to, an expired, blocked or queued state) is part of a link only when that result states it. Empty for a lookup or a status."),
  chainEnd: z.string().optional().describe("For a cause: why the chain stops at its last link: the result that shows the mechanism and what drove it, or the data boundary (the source that would hold the next link, which no connected source covers). Empty for a lookup."),
  conclusion: z.string().describe("The answer in one sentence: the deepest cause in the chain, or the gap that blocks one."),
  confidence: z.enum(CONFIDENCE),
  alternatives: z.array(z.object({
    explanation: z.string(),
    ruledOutBy: z.string().describe("The query result, with its numbers, that eliminates this explanation. Empty when no result eliminates it."),
  })).describe("Competing explanations. For a cause, include normal background noise when it applies."),
  baseline: z.string().describe("For a cause: the suspected cause in a normal window against the incident window, with numbers. Empty when not checked."),
  causeEvidence: z.string().optional().describe("The query result, with its numbers, that shows the cause itself, not only the symptom. Empty when no result shows it."),
  actor: z.string().optional().describe("When the chain reaches a change in client or user activity: who drove it (source and share against the normal window), the verdict (legitimate driver, suspected abuse or undetermined) and the result that decides it. Empty when the chain does not reach client or user activity."),
  contradictions: z.string().describe("Results that do not fit the conclusion. Empty when none."),
});

export type Ledger = z.infer<typeof ledgerSchema>;

export type ConclusionReview = (ledger: Ledger, messages: ModelMessage[], abortSignal: AbortSignal | undefined) => Promise<string | null>;

const STATUS = "Analysis mode active. Follow the analysis rules from your system prompt.";
const NEXT = "For each challenge, when a connected source holds the data, run the queries that settle it now, before the finding card, and write the card from the results (raise or lower the confidence label to match). When a challenge opens a new link of the chain, follow that link to its end before the card. Only when no connected source holds the data, lower the confidence label and name the check in gap. A challenge that shows a cause explains only part of the symptom changes the card: name the cause by the share it explains, find what explains the rest, or put the rest in gap. Never write a card that a challenge contradicts. Do not call begin_analysis again in this reply; a later question gets its own.";

// Models often write "None" or "N/A" where the schema asks for an empty string.
const filled = (text: string) => !/^\W*(none|n\/?a|nothing|not checked|not ruled out|not eliminated)?\W*$/i.test(text);
// "None found" or "No contradictions" means no contradiction; elsewhere a short "no ..." is a real result ("No errors yesterday").
const contradicts = (text: string) => filled(text) && !(/^\W*(no|none)\b/i.test(text) && text.trim().split(/\s+/).length <= 5);

/** Deterministic checks on a cause ledger. Returns one challenge per gap. */
export function challengeLedger(input: Ledger): string[] {
  if (input.question !== "cause") return [];
  const challenges: string[] = [];
  if (!filled(input.chain ?? "") || !filled(input.chainEnd ?? "")) {
    challenges.push("Give the chain from the symptom to the deepest cause and why it ends there. If a connected source holds data on what caused the last link, query it now.");
  }
  if (input.alternatives.length === 0) {
    challenges.push("Name the strongest competing explanation and the result that eliminates it.");
  }
  if (input.confidence === "confirmed") {
    for (const alt of input.alternatives) {
      if (!filled(alt.ruledOutBy)) {
        challenges.push(`"${alt.explanation}" is not eliminated by any result, so the conclusion is not confirmed.`);
      }
    }
    if (!filled(input.causeEvidence ?? "")) {
      challenges.push("No result shows the cause itself, only the symptom. Lower the confidence.");
    }
    if (!filled(input.baseline)) {
      challenges.push("The suspected cause is not compared with a normal window, so it can be background noise.");
    }
  }
  if (contradicts(input.contradictions)) {
    challenges.push("Explain each result that does not fit the conclusion in the report.");
  }
  return challenges;
}

type AnalysisOutput = { status: string; challenges?: string[]; next?: string; cited?: string };

/** The whole text of results the ledger cites that were cut from the context, so the card quotes them, not a memory of them. */
export type CitedResults = (ledger: Ledger, messages: ModelMessage[]) => string | undefined;

/** Tool the agent calls before its final report. It checks the hypothesis ledger and returns challenges. */
export function createBeginAnalysisTool(review?: ConclusionReview, citedResults?: CitedResults): Tool<Ledger, AnalysisOutput> {
  return tool({
    description:
      "Call this tool when you are ready to present your findings. Fill in the ledger from the results you have. The tool checks it and may return challenges to settle in your report. This marks the start of your analysis section. Everything you write after calling this tool will be displayed with distinct analysis styling.",
    inputSchema: ledgerSchema,
    execute: async (input, options): Promise<AnalysisOutput> => {
      const challenges = challengeLedger(input);
      // Every ledger is reviewed: the reviewer also catches a cause question filed as a lookup.
      if (review) {
        const text = (await review(input, options.messages, options.abortSignal))?.trim();
        if (text && !/^\W*OK\W*$/i.test(text)) challenges.push(text);
      }
      const cited = citedResults?.(input, options.messages);
      return { status: STATUS, ...(challenges.length && { challenges, next: NEXT }), ...(cited && { cited }) };
    },
  });
}

export const beginAnalysisTool = createBeginAnalysisTool();

export const ANALYSIS_TOOL_NAME = TOOL_NAMES.BEGIN_ANALYSIS;

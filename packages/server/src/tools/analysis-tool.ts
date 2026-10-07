import { z } from "zod";
import { tool, type ModelMessage, type Tool } from "ai";
import { CONFIDENCE, TOOL_NAMES } from "@tracer-sh/shared";

const ledgerSchema = z.object({
  question: z.enum(["lookup", "cause"]).describe("lookup = a count, list or value. cause = why something happens, or what is wrong or healthy."),
  conclusion: z.string().describe("The answer in one sentence, or the gap that blocks one."),
  confidence: z.enum(CONFIDENCE),
  alternatives: z.array(z.object({
    explanation: z.string(),
    ruledOutBy: z.string().describe("The query result, with its numbers, that eliminates this explanation. Empty when no result eliminates it."),
  })).describe("Competing explanations. For a cause, include normal background noise when it applies."),
  baseline: z.string().describe("For a cause: the suspected cause in a normal window against the incident window, with numbers. Empty when not checked."),
  causeEvidence: z.string().optional().describe("The query result, with its numbers, that shows the cause itself, not only the symptom. Empty when no result shows it."),
  contradictions: z.string().describe("Results that do not fit the conclusion. Empty when none."),
});

export type Ledger = z.infer<typeof ledgerSchema>;

export type ConclusionReview = (ledger: Ledger, messages: ModelMessage[], abortSignal: AbortSignal | undefined) => Promise<string | null>;

const STATUS = "Analysis mode active. Follow the analysis rules from your system prompt.";
const NEXT = "Settle each challenge in the finding card: lower the confidence label or name it in toConfirm, and make a query that settles it your first visual. Do not call begin_analysis again.";

// Models often write "None" or "N/A" where the schema asks for an empty string.
const filled = (text: string) => !/^\W*(none|n\/?a|nothing|not checked|not ruled out|not eliminated)?\W*$/i.test(text);

/** Deterministic checks on a cause ledger. Returns one challenge per gap. */
export function challengeLedger(input: Ledger): string[] {
  if (input.question !== "cause") return [];
  const challenges: string[] = [];
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
  if (filled(input.contradictions)) {
    challenges.push("Explain each result that does not fit the conclusion in the report.");
  }
  return challenges;
}

type AnalysisOutput = { status: string; challenges?: string[]; next?: string };

/** Tool the agent calls before its final report. It checks the hypothesis ledger and returns challenges. */
export function createBeginAnalysisTool(review?: ConclusionReview): Tool<Ledger, AnalysisOutput> {
  return tool({
    description:
      "Call this tool when you are ready to present your findings. Fill in the ledger from the results you have. The tool checks it and may return challenges to settle in your report. This marks the start of your analysis section. Everything you write after calling this tool will be displayed with distinct analysis styling.",
    inputSchema: ledgerSchema,
    execute: async (input, options): Promise<AnalysisOutput> => {
      const challenges = challengeLedger(input);
      if (input.question === "cause" && review) {
        const text = (await review(input, options.messages, options.abortSignal))?.trim();
        if (text && !/^\W*OK\W*$/i.test(text)) challenges.push(text);
      }
      return challenges.length === 0 ? { status: STATUS } : { status: STATUS, challenges, next: NEXT };
    },
  });
}

export const beginAnalysisTool = createBeginAnalysisTool();

export const ANALYSIS_TOOL_NAME = TOOL_NAMES.BEGIN_ANALYSIS;

import { tool, type ModelMessage, type Tool } from "ai";
import { cardRejected, findingSchema, TOOL_NAMES, type Finding } from "@tracer-sh/shared";
import { claimedNumbers, derived, groundingProblems, queryResults, resultNumbers, shown, key } from "./grounding.js";
import type { StepResult } from "../agents/utility/review.js";
import { ANALYSIS_TOOL_NAME, AUTOMATED, type Ledger } from "./analysis-tool.js";

type FindingOutput = { recorded: true; unchecked?: string } | { recorded: false; problems: string; next: string };

const NEXT = "The card is not shown. Fix each problem: cite the exact title of a query that succeeded in this turn and state only numbers its result shows (call read_result for a cut result), or reword the statement. Then call report_finding again with the whole card now: the reply has no answer until you do.";

export const MAX_SEND_BACKS = 2;

const label = (statement: string) => `"${statement.trim().split(/\s+/).slice(0, 6).join(" ")}..."`;

const succeeded = (messages: ModelMessage[], is: (toolName: string) => boolean) =>
  messages.some((m) => m.role === "tool" && m.content.some((p) => p.type === "tool-result" && is(p.toolName) && !String((p.output as { type?: unknown } | null)?.type).startsWith("error")));

// A dismissed firing is answered without an investigation, so it needs no ledger.
const analysisRan = (messages: ModelMessage[]) => succeeded(messages, (name) => name === ANALYSIS_TOOL_NAME || name === "dismiss_alert");

function lastAnalysis(turn: ModelMessage[]): { ledger?: Partial<Ledger>; challenges: string[]; unreviewed: boolean } {
  const last: { ledger?: Partial<Ledger>; challenges: string[]; unreviewed: boolean } = { challenges: [], unreviewed: false };
  for (const m of turn) {
    if (m.role === "assistant" && typeof m.content !== "string") for (const p of m.content) if (p.type === "tool-call" && p.toolName === ANALYSIS_TOOL_NAME) last.ledger = p.input as Partial<Ledger>;
    if (m.role === "tool") for (const p of m.content) {
      if (p.type !== "tool-result" || p.toolName !== ANALYSIS_TOOL_NAME) continue;
      const value = (p.output as { value?: { challenges?: unknown; unreviewed?: unknown } } | null)?.value;
      const raw = value?.challenges;
      last.challenges = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
      last.unreviewed = value?.unreviewed === true;
    }
  }
  return last;
}

/** Reviewer challenges from the last ledger; grounding ones are settled by the card's own checks. */
const openChallenges = (turn: ModelMessage[]) => lastAnalysis(turn).challenges.filter((c) => !/^(split\.|afterEnd:|actor\.)/.test(c));

/** True when the last ledger backs an automated-traffic claim with a grounded indicator and its share of the change. */
function actorBacked(turn: ModelMessage[]): boolean {
  const { ledger, challenges } = lastAnalysis(turn);
  return !!ledger?.actor?.indicator?.statement?.trim() && !!ledger.actor.holdsChange?.statement?.trim() && !challenges.some((c) => /actor\./.test(c));
}

const said = (c: Partial<Finding>) => JSON.stringify([c.title, c.answer, c.explanation?.map((e) => e.statement)]);

/** True when the card repeats the last card sent back in this turn, word for word. */
function unchanged(card: Finding, turn: ModelMessage[]): boolean {
  let last: Partial<Finding> | undefined;
  for (const m of turn) if (m.role === "assistant" && typeof m.content !== "string") for (const p of m.content) if (p.type === "tool-call" && p.toolName === TOOL_NAMES.FINDING) last = p.input as Partial<Finding>;
  return !!last && said(last) === said(card);
}

/** The claims of the card that no result backs. */
function cardProblems(card: Finding, turn: ModelMessage[], results: Map<string, string>, analysisAvailable: boolean, final: boolean): string[] {
  const evidence: string[] = [];
  // The last step and the repair pass offer only report_finding, so no ledger can follow.
  if (card.kind === "root_cause" && analysisAvailable && !final && !analysisRan(turn)) evidence.push("Call begin_analysis with the ledger before the card.");
  const answerNumbers = claimedNumbers(card.answer);
  const cited = card.explanation.flatMap((e) => resultNumbers(results.get(key(e.source)) ?? ""));
  const answerGrounded = answerNumbers.filter((n) => shown(cited, n.value, n.decimals)).map((n) => n.value);
  card.explanation.forEach((e, i) => evidence.push(...groundingProblems(`Statement ${i + 1} ${label(e.statement)}`, e.statement, [e.source], results, answerGrounded)));
  const cardNumbers = [...answerNumbers, ...card.explanation.flatMap((e) => claimedNumbers(e.statement))].filter((n) => shown(cited, n.value, n.decimals)).map((n) => n.value);
  const worked = derived(cardNumbers);
  if (cited.length) for (const n of answerNumbers) if (!shown(cited, n.value, n.decimals) && !shown(worked, n.value, n.decimals)) evidence.push(`answer: ${n.text} is not in the result of any cited source.`);
  const text = [card.title, card.answer, ...card.explanation.map((e) => e.statement)].join(" ");
  const asked = turn.some((m) => m.role === "user" && AUTOMATED.test(typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ")));
  if (analysisAvailable && !asked && AUTOMATED.test(text) && !actorBacked(turn)) evidence.push("The card calls traffic automated, a bot or an attack, but the ledger has no actor.indicator and actor.holdsChange from results. Describe it as unusual traffic from its source, by count and share.");
  return evidence;
}

export function reportFindingTool(
  originals: ReadonlyMap<string, string> = new Map(),
  turnFrom: () => number = () => 0,
  analysisAvailable: () => boolean = () => false,
  final: () => boolean = () => false,
  stepReads: () => StepResult[] = () => [],
): Tool<Finding, FindingOutput> {
  return tool({
    description: "Give every answer as this card. Call it once, alone in its step, as the last action of the reply. State facts from query results only, and fill each field as its description says. "
      + "The card is sent back, at most twice, when it names a number or a source that no result shows, or calls traffic a bot or automated without actor.indicator and actor.holdsChange in the ledger.",
    inputSchema: findingSchema,
    execute: async (card, options): Promise<FindingOutput> => {
      const turn = options.messages.slice(Math.max(0, turnFrom()));
      const sentBack = turn.filter((m) => m.role === "tool" && m.content.some((p) => p.type === "tool-result" && p.toolName === TOOL_NAMES.FINDING && cardRejected((p.output as { value?: unknown }).value))).length;
      const evidence = cardProblems(card, turn, queryResults(turn, originals, stepReads()), analysisAvailable(), final());
      const open = sentBack === 0 || unchanged(card, turn) ? openChallenges(turn) : [];
      if (open.length) evidence.push(`begin_analysis raised challenges. Settle each one with a query, or change the card so that none contradicts it:\n- ${open.join("\n- ")}`);
      if (evidence.length && sentBack < MAX_SEND_BACKS) return { recorded: false, problems: evidence.join("\n"), next: NEXT };
      // A conclusion whose review failed or timed out was not checked, so its card shows as unverified.
      const unchecked = [...evidence, ...(lastAnalysis(turn).unreviewed ? ["The review of the conclusion did not run, so the conclusion is not checked."] : [])];
      return unchecked.length ? { recorded: true, unchecked: unchecked.join("\n") } : { recorded: true };
    },
  });
}

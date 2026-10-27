import { tool, type ModelMessage, type Tool } from "ai";
import { cardRejected, findingSchema, type Finding } from "@tracer-sh/shared";
import { claimedNumbers, derived, groundingProblems, queryResults, resultNumbers, shown, key } from "./grounding.js";
import type { StepResult } from "../agents/utility/review.js";
import { ANALYSIS_TOOL_NAME, AUTOMATED, type Ledger } from "./analysis-tool.js";
import { WRITE_TOOLS } from "./tool-gate.js";

type FindingOutput = { recorded: true; unchecked?: string } | { recorded: false; problems: string; next: string };

const NEXT = "The card is not shown. Fix each problem: cite the exact title of a query that succeeded in this turn and state only numbers its result shows (call read_result for a cut result), or reword the statement. Then call report_finding again with the whole card now: the reply has no answer until you do.";

export const MAX_SEND_BACKS = 2;

const label = (statement: string) => `"${statement.trim().split(/\s+/).slice(0, 6).join(" ")}..."`;

const ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b/i;
const NOT_ACTIONS = new Set(["report_finding", "report_alert_summary", ANALYSIS_TOOL_NAME, "ask_user"]);

const succeeded = (messages: ModelMessage[], is: (toolName: string) => boolean) =>
  messages.some((m) => m.role === "tool" && m.content.some((p) => p.type === "tool-result" && is(p.toolName) && !String((p.output as { type?: unknown } | null)?.type).startsWith("error")));

const acted = (messages: ModelMessage[]) => succeeded(messages, (name) => WRITE_TOOLS.has(name) && !NOT_ACTIONS.has(name));

// A dismissed firing is answered without an investigation, so it needs no ledger.
const analysisRan = (messages: ModelMessage[]) => succeeded(messages, (name) => name === ANALYSIS_TOOL_NAME || name === "dismiss_alert");

function lastAnalysis(turn: ModelMessage[]): { ledger?: Partial<Ledger>; challenges: string[] } {
  const last: { ledger?: Partial<Ledger>; challenges: string[] } = { challenges: [] };
  for (const m of turn) {
    if (m.role === "assistant" && typeof m.content !== "string") for (const p of m.content) if (p.type === "tool-call" && p.toolName === ANALYSIS_TOOL_NAME) last.ledger = p.input as Partial<Ledger>;
    if (m.role === "tool") for (const p of m.content) {
      if (p.type !== "tool-result" || p.toolName !== ANALYSIS_TOOL_NAME) continue;
      const raw = (p.output as { value?: { challenges?: unknown } } | null)?.value?.challenges;
      last.challenges = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
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

const withoutCode = (text: string) => text.replace(/`[^`]*`/g, " ");

const said = (c: Partial<Finding>) => JSON.stringify([c.title, c.answer, c.explanation?.map((e) => e.statement)]);

/** True when the card repeats the last card sent back in this turn, word for word. */
function unchanged(card: Finding, turn: ModelMessage[]): boolean {
  let last: Partial<Finding> | undefined;
  for (const m of turn) if (m.role === "assistant" && typeof m.content !== "string") for (const p of m.content) if (p.type === "tool-call" && p.toolName === "report_finding") last = p.input as Partial<Finding>;
  return !!last && said(last) === said(card);
}

/** `evidence` holds claims no result backs; `style` holds wording rules. Only evidence problems mark a card unchecked. */
function cardProblems(card: Finding, turn: ModelMessage[], results: Map<string, string>, analysisAvailable: boolean, final: boolean): { evidence: string[]; style: string[] } {
  const evidence: string[] = [];
  const style: string[] = [];
  // The last step and the repair pass offer only report_finding, so no ledger can follow.
  if (card.kind === "root_cause" && analysisAvailable && !final && !analysisRan(turn)) evidence.push("Call begin_analysis with the ledger before the card.");
  const answerNumbers = claimedNumbers(card.answer);
  const cited = card.explanation.flatMap((e) => resultNumbers(results.get(key(e.source)) ?? ""));
  const answerGrounded = answerNumbers.filter((n) => shown(cited, n.value, n.decimals)).map((n) => n.value);
  card.explanation.forEach((e, i) => evidence.push(...groundingProblems(`Statement ${i + 1} ${label(e.statement)}`, e.statement, [e.source], results, answerGrounded)));
  const cardNumbers = [...answerNumbers, ...card.explanation.flatMap((e) => claimedNumbers(e.statement))].filter((n) => shown(cited, n.value, n.decimals)).map((n) => n.value);
  const worked = derived(cardNumbers);
  if (cited.length) for (const n of answerNumbers) if (!shown(cited, n.value, n.decimals) && !shown(worked, n.value, n.decimals)) evidence.push(`answer: ${n.text} is not in the result of any cited source.`);
  const seen = new Map<number, number>();
  card.explanation.forEach((e, i) => {
    const own = new Set<number>();
    for (const n of claimedNumbers(e.statement)) {
      if (own.has(n.value)) continue;
      own.add(n.value);
      if (answerNumbers.some((a) => a.value === n.value)) style.push(`statement ${i + 1} repeats ${n.text} from the answer: state each number once; keep it in the answer and give the statement a new fact.`);
      else if (seen.has(n.value)) style.push(`statements ${seen.get(n.value)} and ${i + 1} both state ${n.text}: state each number once.`);
      else seen.set(n.value, i + 1);
    }
  });
  const fields: [string, string | undefined][] = [["title", card.title], ["answer", card.answer], ...card.explanation.map((e, i): [string, string] => [`statement ${i + 1}`, e.statement]), ["unknown", card.unknown], ["action", card.action]];
  for (const [name, text] of fields) {
    if (text && ID.test(withoutCode(text))) style.push(`The ${name} holds an id. Name the service, endpoint or condition instead of the id.`);
    for (const n of claimedNumbers(text ?? "")) {
      if (n.decimals > 2) style.push(`The ${name} writes ${n.text}: round it to at most two decimals.`);
      if (/^\d{5,}/.test(n.text)) style.push(`The ${name} writes ${n.text}: write it with thousands separators (${Math.trunc(n.value).toLocaleString("en-US")}).`);
    }
  }
  if (card.action !== undefined && !acted(turn)) style.push("Omit action: no tool changed a system in this turn.");
  const text = [card.title, card.answer, ...card.explanation.map((e) => e.statement)].join(" ");
  const asked = turn.some((m) => m.role === "user" && AUTOMATED.test(typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ")));
  if (analysisAvailable && !asked && AUTOMATED.test(text) && !actorBacked(turn)) evidence.push("The card calls traffic automated, a bot or an attack, but the ledger has no actor.indicator and actor.holdsChange from results. Describe it as unusual traffic from its source, by count and share.");
  return { evidence, style };
}

export function reportFindingTool(
  originals: ReadonlyMap<string, string> = new Map(),
  turnFrom: () => number = () => 0,
  analysisAvailable: () => boolean = () => false,
  final: () => boolean = () => false,
  stepReads: () => StepResult[] = () => [],
): Tool<Finding, FindingOutput> {
  return tool({
    description: "Show the answer as a card. The card is the whole written answer: call it once, alone in its step, in every turn that ran at least one query, after the investigation. "
      + "Use kind root_cause (with a verdict) when the turn explains why something happened, summary for status, counts, trends and lookups. Skip it only when no query ran. Facts from query results only; never a fix. You may state an action you performed in this turn as a fact. "
      + "Each explanation source is the exact title of a query that succeeded in this turn, and each number in a statement is in that query's result. Each number in the answer is in the result of a source the explanation cites. Each number appears once in the card: a number in the answer is in no statement. At most two decimals, thousands separators, no ids. A card that calls traffic a bot or automated needs actor.indicator and actor.holdsChange in the ledger. A card that fails these checks is sent back, at most twice.",
    inputSchema: findingSchema,
    execute: async (card, options): Promise<FindingOutput> => {
      const turn = options.messages.slice(Math.max(0, turnFrom()));
      const sentBack = turn.filter((m) => m.role === "tool" && m.content.some((p) => p.type === "tool-result" && p.toolName === "report_finding" && cardRejected((p.output as { value?: unknown }).value))).length;
      const { evidence, style } = cardProblems(card, turn, queryResults(turn, originals, stepReads()), analysisAvailable(), final());
      const open = sentBack === 0 || unchanged(card, turn) ? openChallenges(turn) : [];
      if (open.length) evidence.push(`begin_analysis raised challenges. Settle each one with a query, or change the card so that none contradicts it:\n- ${open.join("\n- ")}`);
      if (sentBack >= MAX_SEND_BACKS) return evidence.length ? { recorded: true, unchecked: evidence.join("\n") } : { recorded: true };
      const problems = [...evidence, ...style];
      return problems.length ? { recorded: false, problems: problems.join("\n"), next: NEXT } : { recorded: true };
    },
  });
}

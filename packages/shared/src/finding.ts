import { z } from "zod";

export const CONFIDENCE = ["confirmed", "likely", "unverified"] as const;

export const FINDING_KIND = ["root_cause", "summary", "answer"] as const;

export const VERDICT = ["problem", "no_problem", "unclear"] as const;

const INLINE = "Inline markdown only: **bold** for at most one key fact, `code` only for a name the reader must search for verbatim. No headings, lists, links or HTML.";

const PLAIN = "Write for a person who did not see the investigation: plain words, the name a person uses for each thing (\"error rate\", \"login endpoint\"), never a raw field name, query fragment or id.";

const statementSchema = z.object({
  statement: z.string().describe(`One fact of at most 25 words that a cited result shows, with its number and window. ${PLAIN} ${INLINE}`),
  source: z.string().describe("The exact title of the query in this turn whose result shows the statement."),
});

export const findingSchema = z.object({
  kind: z.enum(FINDING_KIND).describe("root_cause when the question asks why something happened; summary for status, health, trend and comparison questions, even when the check finds a problem or finds nothing wrong; answer for a direct question (a yes or no, a value, a list, a lookup) and for a reply that ran no query"),
  verdict: z.enum(VERDICT).optional().describe("root_cause only, required for it: problem when something is broken or degraded; no_problem when the signal is expected, normal or noise; unclear when the data stops short."),
  confidence: z.enum(CONFIDENCE).optional().describe("root_cause only: confirmed only when a cited result shows the cause itself and another rules out the strongest alternative; likely when an alternative is still open; unverified otherwise."),
  title: z.string().describe(`The card title: at most 10 words that name what happened and why, or what was found. Sentence case, no number, no trailing period. ${PLAIN}`),
  answer: z.string().describe(`The top section: the direct answer to the question as asked, in one or two sentences of at most 45 words together. A yes or no question starts with Yes or No. When a number sizes the answer, it stands next to one normal level, from one result, in the same unit and window length. A why question: the deepest cause the data shows, never the symptom alone; when the cause explains only part of the symptom, state the share. A worst, biggest or which question: name it and its lead over the next one. When the data contradicts the question, state the measured value first. When the cause is not found, say where the data stops. When the source the question names failed, say so first and answer from the other sources; unknown names what the failure hides. Call something healthy only when no part you measured moved far from its normal level; otherwise name that part first, with its change. A funnel or a flow: name the step that loses the most people and its conversion next to normal. A follow-up question gets its own answer. ${PLAIN} ${INLINE}`),
  explanation: z.array(statementSchema).max(6).describe("The evidence section: only the facts that prove the top section, in reading order, as few as the question needs. Empty when no query ran. root_cause: each statement answers why the one before it happened, from the symptom down to the deepest cause, then one statement shows the result that rules out the strongest alternative and, when the Actor check ran, one shows who drove it. summary and answer: the facts behind the answer, one per item; in a status answer, each value next to its baseline from a result. A statement no result shows is not here: it goes in unknown. Each statement adds a fact the answer and the other statements do not state: each number appears once in the whole card, with its window."),
  unknown: z.string().optional().describe(`What no connected source can show and that changes what the reader does next, then what the results show about it. A statement, never a question, a check to run or a query you can run yourself: run it before the card. Required when confidence is not confirmed, and in a summary when the question names a change (a release, a deploy) whose time or effect no result shows. ${PLAIN} ${INLINE}`),
  action: z.string().optional().describe(`An action on a system that a tool call in this turn performed and that succeeded, such as closing an issue. Queries are not actions. Omit it otherwise. ${PLAIN}`),
});

export type Finding = z.infer<typeof findingSchema>;

/** A saved card shows a title or an answer. */
export const savedFindingSchema = findingSchema.refine((f) => f.title.trim() || f.answer.trim());

type PartLike = { type: string; state?: string; input?: unknown; output?: unknown };

/** A card the check sent back for fixes: saved in the reply, never shown. */
export const cardRejected = (output: unknown) => (output as { recorded?: unknown } | null | undefined)?.recorded === false;

/** A card recorded after its last send-back while some checks still failed. */
export const cardUnchecked = (output: unknown) => typeof (output as { unchecked?: unknown } | null | undefined)?.unchecked === "string";

export const UNCHECKED_NOTE = "Some claims in this card did not pass the evidence checks; treat them as unverified.";

export const asUnverified = <T extends { unknown?: string }>(card: T) => ({ ...card, confidence: "unverified" as const, unknown: card.unknown ? `${card.unknown} ${UNCHECKED_NOTE}` : UNCHECKED_NOTE });

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const lines = (v: unknown) => text(v).split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);

// Cards saved before the title/answer/explanation shape: headline, chain, impact, gap, details and points (and the older rootCause/evidence).
export function normalizeFinding(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const r = input as Record<string, unknown>;
  if ("answer" in r || "explanation" in r || !("headline" in r || "rootCause" in r)) return r;
  const { headline, rootCause, chain, impact, gap, details, points, evidence, happened, cause, toConfirm, ...rest } = r;
  const statements: { statement: string; source: string }[] = [];
  const push = (statement: unknown, source?: unknown) => { if (text(statement)) statements.push({ statement: text(statement), source: text(source) }); };
  for (const l of Array.isArray(chain) ? chain : []) push((l as { fact?: unknown })?.fact, (l as { query?: unknown })?.query);
  push(happened);
  push(cause);
  for (const d of lines(details)) push(d);
  for (const p of [...(Array.isArray(points) ? points : []), ...(Array.isArray(evidence) ? evidence : [])]) push(typeof p === "string" ? p : (p as { fact?: unknown })?.fact);
  push(impact);
  return {
    ...rest,
    kind: r.kind ?? "root_cause",
    title: "",
    answer: text(headline) || text(rootCause),
    explanation: statements.slice(0, 6),
    ...((text(gap) || text(toConfirm)) && { unknown: text(gap) || text(toConfirm) }),
  };
}

/** The input of the last recorded report_finding call whose input is valid. */
export function findingFromMessages(messages: ReadonlyArray<{ parts: ReadonlyArray<PartLike> }>): Finding | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== "tool-report_finding" || p.state !== "output-available" || cardRejected(p.output)) continue;
      const parsed = savedFindingSchema.safeParse(normalizeFinding(p.input));
      if (!parsed.success) continue;
      const f = cardUnchecked(p.output) ? asUnverified(parsed.data) : parsed.data;
      return f.kind !== "root_cause" ? { kind: f.kind, title: f.title, answer: f.answer, explanation: f.explanation, ...(f.unknown && { unknown: f.unknown }), ...(f.action && { action: f.action }) } : { ...f, confidence: f.confidence ?? "unverified" };
    }
  }
  return null;
}

/** The distinct sources of a card, in first-cited order; a statement's number is its source's index + 1. */
export function findingSources(f: Pick<Finding, "explanation">): string[] {
  const seen = new Map<string, string>();
  for (const e of f.explanation) {
    const key = e.source.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, e.source.trim());
  }
  return [...seen.values()];
}

const VERDICT_LABEL: Record<NonNullable<Finding["verdict"]>, string> = { problem: "Problem", no_problem: "No problem", unclear: "Unclear" };

export function findingMarkdown(f: Finding): string {
  const sources = findingSources(f);
  const label = f.kind !== "root_cause" ? "" : `${f.verdict ? VERDICT_LABEL[f.verdict] : "Finding"} (${f.confidence ?? "unverified"})`;
  const parts = [
    `${label ? `**${label}:** ` : ""}${f.title ? `${f.title}\n\n` : ""}${f.answer}`,
    f.explanation.length ? `${f.explanation.map((e, i) => `${i + 1}. ${e.statement}`).join("\n")}` : "",
    f.action ? `**Action taken:** ${f.action}` : "",
    f.unknown ? `**Unknown:** ${f.unknown}` : "",
    sources.length ? `**Sources:**\n${sources.map((s) => `- ${s}`).join("\n")}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

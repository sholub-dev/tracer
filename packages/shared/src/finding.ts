import { z } from "zod";

export const CONFIDENCE = ["confirmed", "likely", "unverified"] as const;

export const FINDING_KIND = ["root_cause", "summary"] as const;

export const VERDICT = ["problem", "no_problem", "unclear"] as const;

const INLINE = "Inline markdown only: **bold** for at most one key fact, `code` only for a name the reader must search for verbatim. No headings, lists, links or HTML.";

const PLAIN = "Write for a person who did not see the investigation: plain words, the name a person uses for each thing (\"error rate\", \"login endpoint\"), never a raw field name, query fragment or id.";

const statementSchema = z.object({
  statement: z.string().describe(`One fact of at most 25 words that a cited result shows, with its number and window. ${PLAIN} ${INLINE}`),
  source: z.string().describe("The exact title of the query in this turn whose result shows the statement."),
});

export const findingSchema = z.object({
  kind: z.enum(FINDING_KIND).describe("root_cause when the turn explains why something happened or found a problem; summary for status, counts, trends and lookups"),
  verdict: z.enum(VERDICT).optional().describe("root_cause only, required for it: problem when something is broken or degraded; no_problem when the signal is expected, normal or noise; unclear when the data stops short."),
  confidence: z.enum(CONFIDENCE).optional().describe("root_cause only: confirmed only when a cited result shows the cause itself and another rules out the strongest alternative; likely when an alternative is still open; unverified otherwise."),
  title: z.string().describe(`A short title of at most 10 words that names what happened and why, or what was found. Sentence case, no number, no trailing period. ${PLAIN}`),
  answer: z.string().describe(`The direct answer to the question as asked, in one or two sentences of at most 45 words together. It holds the number that sizes the answer next to its normal level, and for a why question the deepest cause the data shows. ${PLAIN} ${INLINE}`),
  explanation: z.array(statementSchema).min(1).max(6).describe("The evidence that proves the answer, in reading order. root_cause: each statement answers why the one before it happened, from the symptom down to the deepest cause, and one statement shows the result that rules out the strongest alternative. summary: the facts behind the answer, one per item. Each statement adds a fact the answer and the other statements do not state: never repeat a number."),
  unknown: z.string().optional().describe(`What no connected source can show and that changes what the reader does next, then what the results show about it. A statement, never a question, a check to run or a fix. Required when confidence is not confirmed, and in a summary when the question names a change (a release, a deploy) whose time or effect no result shows. ${PLAIN} ${INLINE}`),
  action: z.string().optional().describe(`An action on a system that a tool call in this turn performed and that succeeded, such as closing an issue. Queries are not actions. Omit it otherwise. ${PLAIN}`),
});

export type Finding = z.infer<typeof findingSchema>;

/** A saved card: cards from before the explanation field may have none. */
export const savedFindingSchema = findingSchema.extend({ explanation: z.array(statementSchema).max(6) }).refine((f) => f.title.trim() || f.answer.trim());

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
      return f.kind === "summary" ? { kind: "summary", title: f.title, answer: f.answer, explanation: f.explanation, ...(f.unknown && { unknown: f.unknown }), ...(f.action && { action: f.action }) } : { ...f, confidence: f.confidence ?? "unverified" };
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
  const label = f.kind === "summary" ? "Summary" : `${f.verdict ? VERDICT_LABEL[f.verdict] : "Finding"} (${f.confidence ?? "unverified"})`;
  const parts = [
    `**${label}:** ${f.title ? `${f.title}\n\n` : ""}${f.answer}`,
    f.explanation.length ? `**${f.kind === "summary" ? "Details" : "Why"}:**\n${f.explanation.map((e, i) => `${i + 1}. ${e.statement}`).join("\n")}` : "",
    f.action ? `**Action taken:** ${f.action}` : "",
    f.unknown ? `**Unknown:** ${f.unknown}` : "",
    sources.length ? `**Sources:**\n${sources.map((s) => `- ${s}`).join("\n")}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

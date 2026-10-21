import { z } from "zod";

export const CONFIDENCE = ["confirmed", "likely", "unverified"] as const;

export const FINDING_KIND = ["root_cause", "summary"] as const;

export const VERDICT = ["problem", "no_problem", "unclear"] as const;

const INLINE = "Inline markdown only: **bold** for the one or two key facts (a number, a time window, the failing component), `code` for identifiers (exception classes, endpoints, error messages, query fragments). Sparing; no headings, lists, links or HTML.";

const NO_IDS = "No ids (incident, issue, session, UUIDs) anywhere in the card: name the service, endpoint or condition instead. Each field adds facts no other field states: when a field would only repeat, omit it (optional fields) or keep it to the new facts. Fewer words beat more.";

export const findingSchema = z.object({
  kind: z.enum(FINDING_KIND).describe("root_cause when the turn explains why something happened; summary for status, counts, trends and lookups"),
  verdict: z.enum(VERDICT).optional().describe("root_cause only, required for it: problem when something is broken or degraded; no_problem when the signal is expected, normal or noise; unclear when the data stops short."),
  headline: z.string().describe(`The answer to the question as asked, in one plain sentence of at most 25 words, with its key number. root_cause: the deepest cause the data shows, never the symptom alone; a comparison question (worst, biggest, which) names the winner and the margin over the next one. summary: the main takeaway. ${NO_IDS} No "Root cause:" or "Summary:" prefix.`),
  chain: z.array(z.object({
    fact: z.string().describe("At most 20 words, one number or time from the query result. " + INLINE),
    query: z.string().optional().describe("The exact title you gave the query whose result shows this fact"),
  })).min(1).max(6).optional().describe("root_cause only, required for it: the causal chain, one link per item: the first link is the symptom (for a worst, biggest or which question, the ranking with the first and second), each next link answers why the one before it happened, and the last link is the deepest cause the data shows. Each fact is at most 20 words and states only what its query result shows, with its number or time. A mechanism no result measures is not a fact: put it in gap. Each number appears once in the card, as the result shows it. " + INLINE + " " + NO_IDS),
  gap: z.string().optional().describe("root_cause only: the one thing the card does not show that changes what the reader does next: who sent the traffic, why, whether it was legitimate, or a cause no result ruled out. State what is unknown, then what the results show about it, so a person who knows the system can close it, for example \"The client that sent the AHC/2.1 burst is unknown. The requests to `/events/submit` carry no caller service name and peaked at 8,893 per minute at 05:55 PDT.\" Statements only: never a question, a log type, a data source or a time window to check, a query or a fix. Required when the cause is not confirmed. " + INLINE),
  impact: z.string().optional().describe("root_cause only: one short phrase on who or what is affected and how much, only as a result measures it. \"none\" is allowed for no_problem. " + INLINE + " " + NO_IDS),
  action: z.string().optional().describe("root_cause only: an action you took on a system in this turn, for example closing an issue or posting a message. Queries and the investigation are not actions. Omit it otherwise. " + INLINE),
  confidence: z.enum(CONFIDENCE).optional().describe("root_cause only: confirmed only when a query result shows the cause itself, not only the symptom, and rules out the strongest alternative. Ignored for summary."),
  details: z.string().optional().describe("summary only: omit it unless the answer is a list of parallel items; then a short intro line and a \"- \" list, one item per line with its number. **bold** for key facts and `code` for identifiers allowed; no headings, links, tables or HTML. " + NO_IDS),
  points: z.array(z.string()).max(4).optional().describe("summary only: 0 to 3 facts with a number or time from a query result that the headline and details do not state. " + INLINE),
});

export type Finding = z.infer<typeof findingSchema>;

type PartLike = { type: string; state?: string; input?: unknown; output?: unknown };

/** A card the review sent back for fixes: saved in the reply, never shown. */
export const cardRejected = (output: unknown) => (output as { recorded?: unknown } | null | undefined)?.recorded === false;

type Link = { fact: string; query?: string };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Older calls saved rootCause and evidence instead of kind, headline and points. Older root_cause cards saved details and points, then happened, cause, evidence and toConfirm: they show as a chain and a gap.
export function normalizeFinding(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const r = input as Record<string, unknown>;
  if (!("kind" in r)) {
    const { rootCause, evidence, ...rest } = r;
    return normalizeFinding({ ...rest, kind: "root_cause", headline: rootCause, points: evidence });
  }
  if (r.kind !== "root_cause" || r.chain !== undefined) return r;
  const { details, points, happened, cause, evidence, toConfirm, ...rest } = r;
  const legacy = [details, points, happened, cause, evidence, toConfirm].some((v) => v !== undefined);
  if (!legacy) return r;
  const items = (v: unknown): Link[] => (Array.isArray(v) ? v : []).flatMap((e) => {
    const link = typeof e === "string" ? { fact: e } : (e as Link | null);
    return text(link?.fact) ? [{ ...link, fact: link!.fact }] : [];
  });
  const chain: Link[] = [text(happened) || text(details), text(cause)].filter(Boolean).map((fact) => ({ fact }));
  chain.push(...items(evidence), ...items(points));
  return { ...rest, ...(chain.length > 0 && { chain: chain.slice(0, 6) }), ...(text(toConfirm) && { gap: text(toConfirm) }) };
}

/** The input of the last successful report_finding call whose input is valid. */
export function findingFromMessages(messages: ReadonlyArray<{ parts: ReadonlyArray<PartLike> }>): Finding | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== "tool-report_finding" || p.state !== "output-available" || cardRejected(p.output)) continue;
      const parsed = findingSchema.safeParse(normalizeFinding(p.input));
      if (!parsed.success) continue;
      const f = parsed.data;
      if (f.kind === "summary") return { kind: "summary", headline: f.headline, details: f.details ?? "", points: f.points ?? [] };
      const { details: _d, points: _p, ...card } = f;
      return { ...card, confidence: f.confidence ?? "unverified" };
    }
  }
  return null;
}

const VERDICT_LABEL: Record<NonNullable<Finding["verdict"]>, string> = { problem: "Problem", no_problem: "No problem", unclear: "Unclear" };

export function findingMarkdown(f: Finding): string {
  if (f.kind === "summary") {
    const details = f.details ? `${f.details}\n\n` : "";
    return `**Summary:** ${f.headline}\n\n${details}${(f.points ?? []).map((e) => `- ${e}`).join("\n")}`.trimEnd();
  }
  const label = f.verdict ? VERDICT_LABEL[f.verdict] : "Finding";
  const section = (title: string, body?: string) => (body ? `**${title}:** ${body}` : "");
  const chain = f.chain?.length ? `**Chain:**\n${f.chain.map((e, i) => `${i + 1}. ${e.fact}${e.query ? ` (query: ${e.query})` : ""}`).join("\n")}` : "";
  const parts = [
    `**${label}** (${f.confidence ?? "unverified"}): ${f.headline}`,
    chain,
    section("Impact", f.impact),
    section("Action taken", f.action),
    section("Unknown", f.gap),
  ];
  return parts.filter(Boolean).join("\n\n");
}

import { z } from "zod";

export const CONFIDENCE = ["confirmed", "likely", "unverified"] as const;

export const FINDING_KIND = ["root_cause", "summary"] as const;

export const VERDICT = ["problem", "no_problem", "unclear"] as const;

const INLINE = "Inline markdown only: **bold** for the one or two key facts (a number, a time window, the failing component), `code` for identifiers (exception classes, endpoints, error messages, query fragments). Sparing; no headings, lists, links or HTML.";

const LISTS = "Markdown: **bold** for key facts, `code` for identifiers. When the field covers several parallel items (services, endpoints, time windows, steps), write a short intro line, then a \"- \" list, one item per line with its number; otherwise prose. No headings, links, tables or HTML.";

const NO_IDS = "No ids (incident, issue, session, UUIDs) anywhere in the card: name the service, endpoint or condition instead. Each field adds facts no other field states: when a field would only repeat, omit it (optional fields) or keep it to the new facts. Fewer words beat more.";

export const findingSchema = z.object({
  kind: z.enum(FINDING_KIND).describe("root_cause when the turn explains why something happened; summary for status, counts, trends and lookups"),
  verdict: z.enum(VERDICT).optional().describe("root_cause only, required for it: problem when something is broken or degraded; no_problem when the signal is expected, normal or noise; unclear when the data stops short."),
  headline: z.string().describe(`The answer in one plain sentence of at most 25 words, with its key number. root_cause: the cause (the change, condition or failing dependency); when the data shows only the symptom, what the data shows and where it stops. Never the symptom alone. summary: the main takeaway. ${NO_IDS} No "Root cause:" or "Summary:" prefix.`),
  happened: z.string().optional().describe("root_cause only, optional: one sentence with only what the headline leaves out: where, when, how much. Omit it when the headline already covers it. " + LISTS + " " + NO_IDS),
  cause: z.string().optional().describe("root_cause only: 1 to 2 sentences on the mechanism, only what the headline leaves out; never a restatement of the headline. Label a candidate cause as a candidate. " + LISTS + " " + NO_IDS),
  evidence: z.array(z.object({
    fact: z.string().describe("One fact with a number or time from a query result. " + INLINE),
    query: z.string().optional().describe("The exact title you gave the query whose result shows this fact"),
  })).max(5).optional().describe("root_cause only: 2 to 4 short facts (at most 15 words each), each one number or time from a query result, only facts not already in other fields. " + NO_IDS),
  impact: z.string().optional().describe("root_cause only: one short phrase on who or what is affected and how much. \"none\" is allowed for no_problem. " + INLINE + " " + NO_IDS),
  action: z.string().optional().describe("root_cause only: an action you performed in this turn, stated as a fact (for example that you closed the issue). Never a fix for the user to make. " + INLINE),
  confidence: z.enum(CONFIDENCE).optional().describe("root_cause only: confirmed only when a query result shows the cause itself, not only the symptom, and rules out the strongest alternative. Ignored for summary."),
  toConfirm: z.string().optional().describe("root_cause only: one check that would confirm the cause and needs data the connected sources do not hold, naming the data and the time window to look at, e.g. \"Deploy history 14:35-14:45\". Never a query you can run yourself. Never a fix or an action on the system. Omit when confidence is confirmed. " + INLINE),
  details: z.string().optional().describe("summary only: 1 to 3 sentences; the first answers the question directly, the rest add key numbers and the time window from query results. When the answer covers several parallel items (services, endpoints, time windows, steps), list them as a short markdown list, one item per line with its number. **bold** for key facts and `code` for identifiers allowed; no headings, links, tables or HTML. " + NO_IDS),
  points: z.array(z.string()).max(4).optional().describe("summary only: 0 to 3 facts with a number or time from a query result, only facts not already in details. " + INLINE),
});

export type Finding = z.infer<typeof findingSchema>;

type PartLike = { type: string; state?: string; input?: unknown };

const isNewCard = (r: Record<string, unknown>) => r.verdict !== undefined || r.happened !== undefined || r.cause !== undefined || r.evidence !== undefined;

// Older calls saved rootCause and evidence instead of kind, headline and points. Older root_cause cards saved details and points: they show as happened and evidence.
export function normalizeFinding(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const r = input as Record<string, unknown>;
  if (!("kind" in r)) {
    const { rootCause, evidence, ...rest } = r;
    return normalizeFinding({ ...rest, kind: "root_cause", headline: rootCause, points: evidence });
  }
  if (r.kind === "root_cause" && !isNewCard(r)) {
    const { details, points, ...rest } = r;
    const facts = Array.isArray(points) ? points.filter((p): p is string => typeof p === "string").map((fact) => ({ fact })) : [];
    return {
      ...rest,
      ...(typeof details === "string" && details && { happened: details }),
      ...(facts.length > 0 && { evidence: facts }),
    };
  }
  return r;
}

/** The input of the last successful report_finding call whose input is valid. */
export function findingFromMessages(messages: ReadonlyArray<{ parts: ReadonlyArray<PartLike> }>): Finding | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== "tool-report_finding" || p.state !== "output-available") continue;
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
  const evidence = f.evidence?.length ? `**Evidence:**\n${f.evidence.map((e) => `- ${e.fact}${e.query ? ` (query: ${e.query})` : ""}`).join("\n")}` : "";
  const parts = [
    `**${label}** (${f.confidence ?? "unverified"}): ${f.headline}`,
    section("What happened", f.happened),
    section("Why", f.cause),
    evidence,
    section("Impact", f.impact),
    section("Action taken", f.action),
    section("To confirm", f.toConfirm),
  ];
  return parts.filter(Boolean).join("\n\n");
}

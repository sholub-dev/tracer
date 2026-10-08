import { z } from "zod";

export const CONFIDENCE = ["confirmed", "likely", "unverified"] as const;

export const FINDING_KIND = ["root_cause", "summary"] as const;

export const VERDICT = ["problem", "no_problem", "unclear"] as const;

const INLINE = "Inline markdown only: **bold** for the one or two key facts (a number, a time window, the failing component), `code` for identifiers (exception classes, endpoints, error messages, query fragments). Sparing; no headings, lists, links or HTML.";

const LISTS = "Markdown: **bold** for key facts, `code` for identifiers. When the field covers several parallel items (services, endpoints, time windows, steps), write a short intro line, then a \"- \" list, one item per line with its number; otherwise prose. No headings, links, tables or HTML.";

const NO_IDS = "No ids (incident, issue, session, UUIDs) anywhere in the card: name the service, endpoint or condition instead. Nothing repeated across fields.";

export const findingSchema = z.object({
  kind: z.enum(FINDING_KIND).describe("root_cause when the turn explains why something happened; summary for status, counts, trends and lookups"),
  verdict: z.enum(VERDICT).optional().describe("root_cause only, required for it: problem when something is broken or degraded; no_problem when the signal is expected, normal or noise; unclear when the data stops short."),
  headline: z.string().describe(`One plain sentence. root_cause: what happened and why (the change, condition or failing dependency), never the symptom restated. summary: the main takeaway with its key number. ${NO_IDS} No "Root cause:" or "Summary:" prefix.`),
  happened: z.string().optional().describe("root_cause only: 1 to 2 sentences on what was observed, where, when and how much (numbers and the time window). " + LISTS + " " + NO_IDS),
  cause: z.string().optional().describe("root_cause only: 1 to 3 sentences on the mechanism that explains it, or why it is not a fault. Never the symptom restated. When the data does not show the cause, say where it stops and label any candidate as a candidate. " + LISTS + " " + NO_IDS),
  evidence: z.array(z.object({
    fact: z.string().describe("One fact with a number or time from a query result. " + INLINE),
    query: z.string().optional().describe("The exact title you gave the query whose result shows this fact"),
  })).max(5).optional().describe("root_cause only: 1 to 5 facts from query results, only facts not already in happened or cause. " + NO_IDS),
  impact: z.string().optional().describe("root_cause only: who or what is affected and how much. \"none\" is allowed for no_problem. " + LISTS + " " + NO_IDS),
  action: z.string().optional().describe("root_cause only: an action you performed in this turn, stated as a fact (for example that you closed the issue). Never a fix for the user to make. " + INLINE),
  confidence: z.enum(CONFIDENCE).optional().describe("root_cause only: confirmed only when a query result shows the cause itself, not only the symptom, and rules out the strongest alternative. Ignored for summary."),
  toConfirm: z.string().optional().describe("root_cause only: one check that would confirm the cause, naming the data and the time window to look at, e.g. \"Gateway pool metrics 14:35-14:45\". Never a fix or an action on the system. Omit when confidence is confirmed. " + INLINE),
  details: z.string().optional().describe("summary only: the first sentence answers the question directly; the rest give the key numbers and the time window from query results. When the answer covers several parallel items (services, endpoints, time windows, steps), list them as a short markdown list, one item per line with its number; otherwise write 1 to 5 sentences of prose. **bold** for key facts and `code` for identifiers allowed; no headings, links, tables or HTML. " + NO_IDS),
  points: z.array(z.string()).max(4).optional().describe("summary only: 0 to 4 facts with a number or time from a query result, only facts not already in details. " + INLINE),
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

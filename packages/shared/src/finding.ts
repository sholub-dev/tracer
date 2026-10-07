import { z } from "zod";

export const CONFIDENCE = ["confirmed", "likely", "unverified"] as const;

export const FINDING_KIND = ["root_cause", "summary"] as const;

export const findingSchema = z.object({
  kind: z.enum(FINDING_KIND).describe("root_cause when the turn explains why something happened; summary for status, counts, trends and lookups"),
  headline: z.string().describe("One sentence. root_cause: what caused it. summary: the main takeaway with its key number. No \"Root cause:\" or \"Summary:\" prefix."),
  details: z.string().describe("2 to 5 sentences: the direct, complete answer to the user's question with the key numbers and the time window, from query results. Inline **bold** and `code` allowed; no lists, no headings."),
  points: z.array(z.string()).min(2).max(4).describe("2 to 4 short facts, each with a number or time taken from a query result"),
  confidence: z.enum(CONFIDENCE).optional().describe("root_cause only: confirmed only when a query result rules out the strongest alternative. Ignored for summary."),
  toConfirm: z.string().optional().describe("root_cause only: one check that would confirm the cause, naming the data and the time window to look at, e.g. \"Gateway pool metrics 14:35-14:45\". Never a fix or an action on the system. Omit when confidence is confirmed."),
});

export type Finding = z.infer<typeof findingSchema>;

type PartLike = { type: string; state?: string; input?: unknown };

// Calls saved before the schema had details have none. Older calls used rootCause and evidence instead of kind, headline and points.
function normalize(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  if ("kind" in input) return { details: "", ...input };
  const { rootCause, evidence, ...rest } = input as Record<string, unknown>;
  return { details: "", ...rest, kind: "root_cause", headline: rootCause, points: evidence };
}

/** The input of the last successful report_finding call whose input is valid. */
export function findingFromMessages(messages: ReadonlyArray<{ parts: ReadonlyArray<PartLike> }>): Finding | null {
  for (const m of [...messages].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== "tool-report_finding" || p.state !== "output-available") continue;
      const parsed = findingSchema.safeParse(normalize(p.input));
      if (!parsed.success) continue;
      const { kind, headline, details, points } = parsed.data;
      return kind === "summary" ? { kind, headline, details, points } : parsed.data;
    }
  }
  return null;
}

export function findingMarkdown(f: Finding): string {
  const head = f.kind === "summary" ? "**Summary:**" : f.confidence ? `**Root cause** (${f.confidence}):` : "**Root cause:**";
  const confirm = f.toConfirm ? `\n\n**To confirm:** ${f.toConfirm}` : "";
  const details = f.details ? `${f.details}\n\n` : "";
  return `${head} ${f.headline}\n\n${details}${f.points.map((e) => `- ${e}`).join("\n")}${confirm}`;
}

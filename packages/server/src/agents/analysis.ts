import type { UIMessage } from "ai";
import { CLIENT_TOOL_NAMES } from "@tracer-sh/shared";

interface MessagePart {
  type: string;
  text?: string;
  input?: { query?: string };
  output?: { parts?: Array<{ query?: string; results?: unknown; totalRows?: number }>; analysis?: string };
}

export interface QueryRecord {
  tool: string;
  query: string;
  results: unknown;
  /** Set when the saved session keeps only the first rows of `results`. */
  totalRows?: number;
}

/** Cap a single result payload so large timeseries don't bloat the response. */
const MAX_RESULT_CHARS = 4000;

/**
 * Render a provider query tool part (e.g. `tool-execute_nrql`) as a markdown
 * block, and push its query+results onto `queries`. These parts carry the actual
 * evidence (the executed query and its rows), so they belong in the analysis —
 * not just the prose around them.
 */
export function renderToolPart(p: MessagePart, queries: QueryRecord[]): string {
  const tool = p.type.replace(/^tool-/, "");
  const queryParts = (p.output?.parts ?? []).filter((x) => typeof x?.query === "string");

  // Always record the saved raw rows for programmatic consumers (the `queries`
  // array in the `--json` envelope). These never go into the prose below.
  for (const qp of queryParts) {
    queries.push({ tool, query: qp.query ?? p.input?.query ?? "", results: qp.results, ...(typeof qp.totalRows === "number" && { totalRows: qp.totalRows }) });
  }

  const queryText = queryParts
    .map((qp) => qp.query ?? p.input?.query ?? "")
    .filter((q): q is string => !!q)
    .join("\n---\n");

  // Prefer the provider's formatted summary — the same compact, already
  // downsampled/aggregated view the model reasoned over. This keeps raw
  // timeseries arrays OUT of the prose analysis (they bloat the output and get
  // tail-clipped when piped through a shell), while the full rows stay in
  // `queries` for anyone who passes `--json`.
  if (p.output?.analysis) {
    if (queryParts.length === 0 && p.input?.query) {
      queries.push({ tool, query: p.input.query, results: p.output.analysis });
    }
    // Show the same query in the prose that we recorded in `queries`: prefer the
    // per-part text, else fall back to the tool's top-level input query.
    const displayQuery = queryText || p.input?.query || "";
    return `Query (${tool}):${displayQuery ? `\n\`\`\`\n${displayQuery}\n\`\`\`` : ""}\nResult:\n${p.output.analysis}`;
  }

  // Fallback: no formatted summary available — emit capped raw JSON per part.
  const blocks: string[] = [];
  for (const qp of queryParts) {
    const query = qp.query ?? p.input?.query ?? "";
    let resultStr: string;
    try {
      resultStr = JSON.stringify(qp.results);
    } catch {
      resultStr = String(qp.results);
    }
    if (resultStr.length > MAX_RESULT_CHARS) {
      resultStr = `${resultStr.slice(0, MAX_RESULT_CHARS)} …[truncated, full rows in queries]`;
    }
    blocks.push(`Query (${tool}):\n\`\`\`\n${query}\n\`\`\`\nResult:\n\`\`\`json\n${resultStr}\n\`\`\``);
  }
  return blocks.join("\n\n");
}

/**
 * Extract the final analysis from a completed session's messages.
 *
 * The agent marks its conclusion by calling the `begin_analysis` tool, persisted
 * as a part of type `tool-begin_analysis`. Everything after the marker of the last message that has one
 * is the final Analysis: text interleaved with provider query tool parts. We
 * serialize both, in order, so the analysis includes the queries and their
 * results (not just the prose). If the agent answered without the marker, fall
 * back to the last assistant message's text. Also returns the queries as a
 * structured array for programmatic consumers.
 */
export function extractAnalysis(messages: UIMessage[]): { analysis: string; queries: QueryRecord[] } {
  const assistantParts: MessagePart[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts as MessagePart[]) assistantParts.push(p);
  }

  // The first marker of the last message that has one, as findAnalysisMarker picks it for compaction.
  let markerIdx = -1;
  let offset = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const idx = m.parts.findIndex((p) => p.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS);
    if (idx >= 0) markerIdx = offset + idx;
    offset += m.parts.length;
  }

  const queries: QueryRecord[] = [];
  const segments: string[] = [];

  if (markerIdx >= 0) {
    for (const p of assistantParts.slice(markerIdx + 1)) {
      if (p.type === "text") {
        if (p.text?.trim()) segments.push(p.text);
      } else if (p.type.startsWith("tool-") && p.type !== CLIENT_TOOL_NAMES.BEGIN_ANALYSIS) {
        const block = renderToolPart(p, queries);
        if (block) segments.push(block);
      }
    }
  } else {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    for (const p of (lastAssistant?.parts as MessagePart[] | undefined) ?? []) {
      if (p.type === "text" && p.text?.trim()) segments.push(p.text);
    }
  }

  return { analysis: segments.join("\n\n").trim(), queries };
}

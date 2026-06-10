import { z } from "zod";

/** Progress part types streamed from sub-agents to the client */
export type ProgressPart =
  | { type: "query"; query: string; results: unknown }
  | { type: "text"; content: string }
  | { type: "tool-call"; toolName: string }
  | { type: "reasoning"; content: string }
  // Marks where the sub-agent's `begin_analysis` tool fired — everything after it
  // is the final Analysis (rendered in the distinct Analysis box, like direct mode).
  | { type: "analysis-start" }
  // Legacy: older persisted sessions styled the last text part as a summary block.
  | { type: "summary"; content: string };

/** Tool names as registered on the server */
export const TOOL_NAMES = {
  CREATE_WIDGET: "create_widget",
  UPDATE_WIDGET: "update_widget",
  DELETE_WIDGET: "delete_widget",
  CREATE_MONITOR: "create_monitor",
  UPDATE_MONITOR: "update_monitor",
  DELETE_MONITOR: "delete_monitor",
  TOGGLE_MONITOR: "toggle_monitor",
  BEGIN_ANALYSIS: "begin_analysis",
} as const;

/** AI SDK prefixes tool names with "tool-" on the client */
export const CLIENT_TOOL_NAMES = Object.fromEntries(
  Object.entries(TOOL_NAMES).map(([k, v]) => [k, `tool-${v}`]),
) as { [K in keyof typeof TOOL_NAMES]: `tool-${(typeof TOOL_NAMES)[K]}` };

/** Marker the agent writes in a text part to signal "analysis starts here". */
export const ANALYSIS_MARKER = "<analysis>";

/** Structural UIMessage shape so this module stays free of the `ai` dependency. */
type MessageLike = { role: string; parts?: ReadonlyArray<{ type: string }> };

/**
 * An analysis (post-mortem) assistant message: contains the begin_analysis
 * tool call, or the legacy text marker.
 */
export function isAnalysisMessage(msg: MessageLike): boolean {
  if (msg.role !== "assistant" || !msg.parts) return false;
  return msg.parts.some((p) => {
    if (p.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS) return true;
    if (p.type !== "text") return false;
    const text = (p as { text?: unknown }).text;
    return typeof text === "string" && text.includes(ANALYSIS_MARKER);
  });
}

/**
 * Resolve "summarize up to message `boundaryIdx`" to the number of leading
 * messages the summary hides (the session's summaryUpTo). Analysis messages
 * are too informative to dismiss: when the boundary is one, it stays visible —
 * the compact mutation still folds its pre-analysis tool work into the
 * summary, but the message itself is not hidden. Returns null when the
 * boundary is not an assistant message or nothing would be left to summarize.
 */
export function compactionUpTo(messages: ReadonlyArray<MessageLike>, boundaryIdx: number): number | null {
  const boundary = messages[boundaryIdx];
  if (!boundary || boundary.role !== "assistant") return null;
  if (!isAnalysisMessage(boundary)) return boundaryIdx + 1;
  return boundaryIdx >= 1 ? boundaryIdx : null;
}

/**
 * Where the analysis section begins in a message's parts: the begin_analysis
 * tool part if present, else the legacy `<analysis>` text marker (with the
 * char offset inside that text part). Single source of truth for analysis-
 * boundary detection — splitAtAnalysis, analysisSectionParts, and the web
 * MessageParts renderer all build on it. Returns null when there is none.
 */
export type AnalysisMarkerPos =
  | { kind: "tool"; partIdx: number }
  | { kind: "text"; partIdx: number; charIdx: number };

export function findAnalysisMarker(parts: ReadonlyArray<{ type: string }>): AnalysisMarkerPos | null {
  const toolIdx = parts.findIndex((p) => p.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS);
  if (toolIdx !== -1) return { kind: "tool", partIdx: toolIdx };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "text") continue;
    const text = (p as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const idx = text.indexOf(ANALYSIS_MARKER);
    if (idx !== -1) return { kind: "text", partIdx: i, charIdx: idx };
  }
  return null;
}

/**
 * Split a message's parts at the analysis marker: `before` is the working
 * section (reasoning, tool calls, intermediate text), `analysis` everything
 * after the marker. Returns null when the message has no analysis section.
 */
export function splitAtAnalysis<P extends { type: string }>(
  parts: ReadonlyArray<P>,
): { before: P[]; analysis: P[] } | null {
  const marker = findAnalysisMarker(parts);
  if (!marker) return null;
  if (marker.kind === "tool") {
    return { before: parts.slice(0, marker.partIdx), analysis: parts.slice(marker.partIdx + 1) };
  }
  const p = parts[marker.partIdx] as P & { text: string };
  const beforeText = p.text.slice(0, marker.charIdx);
  const afterText = p.text.slice(marker.charIdx + ANALYSIS_MARKER.length);
  return {
    before: [...parts.slice(0, marker.partIdx), ...(beforeText.trim() ? [{ ...p, text: beforeText }] : [])],
    analysis: [...(afterText.trim() ? [{ ...p, text: afterText }] : []), ...parts.slice(marker.partIdx + 1)],
  };
}

/**
 * The message's parts from the analysis marker onward, marker included — a
 * render-only view of a kept compaction boundary that shows just the analysis
 * section. Unlike splitAtAnalysis, the marker stays so renderers that key the
 * analysis box off it still work. Returns null when there is no analysis
 * section.
 */
export function analysisSectionParts<P extends { type: string }>(parts: ReadonlyArray<P>): P[] | null {
  const marker = findAnalysisMarker(parts);
  if (!marker) return null;
  if (marker.kind === "tool") return parts.slice(marker.partIdx);
  const p = parts[marker.partIdx] as P & { text: string };
  return [{ ...p, text: p.text.slice(marker.charIdx) }, ...parts.slice(marker.partIdx + 1)];
}

/**
 * Schema for the JSON blob embedded in an analysis PNG. Lives in shared so
 * both the server (`importAnalysis` mutation input) and the web client (drop
 * handler validation) can use the same definition.
 *
 * Parts are accepted opaquely: text, reasoning, and tool parts (with their
 * inputs and outputs) all survive the round-trip so imported sessions render
 * identically to the original, including charts/tables backed by tool output.
 * Size is bounded by the export-time guard in the web client and the overall
 * tRPC body limit on the server.
 */
export const ImportedAnalysisSchema = z.object({
  v: z.literal(1),
  kind: z.literal("analysis"),
  sourceTitle: z.string().max(400),
  sourceCreatedAt: z.number().int().nonnegative(),
  parts: z.array(z.looseObject({ type: z.string() })).max(200),
});

export type ImportedAnalysis = z.infer<typeof ImportedAnalysisSchema>;

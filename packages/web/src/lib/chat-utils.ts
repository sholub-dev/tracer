import { useMemo } from "react";
import type { UIMessage } from "ai";
import type { ProgressStore } from "./progress-store";
import { serverFetch } from "./server-fetch";
import { analysisSectionParts, type ProgressPart } from "@tracer-sh/shared";

/** Shared onData handler for progress store updates (ChatCore and LiveStreamView). */
export function handleProgressData(
  progressStore: ProgressStore,
  data: { toolCallId: string; part: { type: string; [key: string]: unknown } },
) {
  progressStore.update(data.toolCallId, (prev) => {
    // A retry clears the failed attempt's streamed parts before re-streaming.
    if (data.part.type === "reset") return { parts: [] };
    const parts = [...(prev?.parts ?? [])];
    if (data.part.type === "tool-call") {
      parts.push({ type: "tool-call", toolName: data.part.toolName as string });
    } else if (data.part.type === "text-delta") {
      const last = parts[parts.length - 1];
      if (last?.type === "text") {
        parts[parts.length - 1] = { ...last, content: last.content + (data.part.delta as string) };
      } else {
        parts.push({ type: "text", content: data.part.delta as string });
      }
    } else if (data.part.type === "reasoning-delta") {
      const last = parts[parts.length - 1];
      if (last?.type === "reasoning") {
        parts[parts.length - 1] = { ...last, content: last.content + (data.part.delta as string) };
      } else {
        parts.push({ type: "reasoning", content: data.part.delta as string });
      }
    } else if (data.part.type === "query") {
      let tcIdx = -1;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "tool-call") { tcIdx = i; break; }
      }
      if (tcIdx !== -1) parts.splice(tcIdx, 1);
      parts.push({ type: "query", query: data.part.query as string, results: data.part.results });
    } else if (data.part.type === "begin-analysis") {
      // After begin_analysis, everything the sub-agent writes is its final Analysis.
      parts.push({ type: "analysis-start" });
    } else if (data.part.type === "mark-summary") {
      // Legacy: older sub-agents marked the last text part as a summary block.
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i].type === "text") {
          parts[i] = { ...parts[i], type: "summary" } as ProgressPart;
          break;
        }
      }
    }
    return { parts };
  });
}

/** A tool result the server rejected comes back as `{ error }`. */
export function hasErrorOutput(output: unknown): output is { error: unknown } {
  return !!output && typeof output === "object" && "error" in output;
}

/** Ask the server to abort a session's in-flight stream. */
export function stopChat(sessionId: string): Promise<void> {
  return serverFetch("/api/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).then(() => {}, () => {});
}

/** Copies plain text only: Streamdown's nested blocks and link buttons otherwise paste as stray line breaks. */
export function normalizeClipboard(e: React.ClipboardEvent) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  e.clipboardData.setData("text/plain", selection.toString().trimEnd());
  e.preventDefault();
}

export function useParsedMessages(json: string | undefined): UIMessage[] | undefined {
  return useMemo(() => {
    if (json === undefined) return undefined;
    try {
      return JSON.parse(json) as UIMessage[];
    } catch {
      console.warn("[sessions] Corrupted messages JSON");
      return [];
    }
  }, [json]);
}

/** Only the analysis section of a kept compaction boundary; null when it has none. */
function analysisOnly(msg: UIMessage | undefined): UIMessage | null {
  if (!msg || msg.role !== "assistant") return null;
  const parts = analysisSectionParts(msg.parts);
  return parts ? { ...msg, parts } : null;
}

/** Render-only compaction: rows before `collapse` are hidden and the boundary row shows only its analysis. */
export function useCompactedMessages(messages: UIMessage[], collapseCount: number, analysisOnlyIndex: number | undefined) {
  // A boundary past the list end (stale summary) hides nothing.
  const collapse = collapseCount <= messages.length ? collapseCount : 0;
  // Keyed on the boundary message itself, so its row's memo survives streamed tokens.
  const boundaryMsg = analysisOnlyIndex !== undefined ? messages[analysisOnlyIndex] : undefined;
  const analysisOnlyMsg = useMemo(() => analysisOnly(boundaryMsg), [boundaryMsg]);
  return { collapse, analysisOnlyMsg };
}

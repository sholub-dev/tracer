import type { ProgressStore } from "./progress-store";
import type { ProgressPart } from "@tracer-sh/shared";

/**
 * Shared onData handler for progress store updates.
 * Identical logic used in both Debug.tsx and PanelChat.tsx.
 */
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
      // The sub-agent called begin_analysis — everything after this is its final Analysis,
      // rendered in the distinct Analysis box (same as direct mode).
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

/**
 * Normalize clipboard on copy: provides clean plain text only.
 * Fixes two issues:
 * 1. Nested block elements (Streamdown div → p) add trailing newlines on triple-click
 * 2. Streamdown renders emails/links as <button> elements (link safety) which Slack
 *    and other apps interpret as block elements, replacing them with line breaks
 */
export function normalizeClipboard(e: React.ClipboardEvent) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  e.clipboardData.setData("text/plain", selection.toString().trimEnd());
  e.preventDefault();
}

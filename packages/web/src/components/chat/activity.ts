import type { UIMessage } from "ai";
import { CLIENT_TOOL_NAMES, findingFromMessages } from "@tracer-sh/shared";
import { lastTurnMessage } from "../../lib/message-queue";
import { isAskPart, isProviderTool, toolActivity, type ToolPart } from "./ToolParts";

const settled = (state?: string) => state === "output-available" || state === "output-error";

/** What a running reply does now, for the indicator at its tail; null while its own text streams. */
export function activityLabel(messages: UIMessage[]): string | null {
  const reply = lastTurnMessage(messages);
  if (reply?.role !== "assistant") return "Thinking";
  const running = reply.parts.findLast((p) => p.type.startsWith("tool-") && !isAskPart(p.type) && !settled((p as ToolPart).state));
  if (running) return toolActivity(running as ToolPart);
  const last = reply.parts.findLast((p) => p.type !== "step-start");
  return last?.type === "text" && last.state === "streaming" ? null : "Thinking";
}

/**
 * Whether a saved reply that ends on a finished tool call holds its answer. A tool can follow the answer (a timer, a
 * status or alert report), so a card, or text after the last query, completes it. A reply that began its analysis owes a
 * card, and one that ends on a query has no answer yet.
 */
export function endsAnswered(reply: UIMessage): boolean {
  const parts = reply.parts;
  if ((parts.at(-1) as { state?: string } | undefined)?.state !== "output-available") return false;
  if (findingFromMessages([reply])) return true;
  if (parts.some((p) => p.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS)) return false;
  const lastQuery = parts.findLastIndex((p) => isProviderTool(p.type));
  return parts.slice(lastQuery + 1).some((p) => p.type === "text" && p.text.trim() !== "");
}

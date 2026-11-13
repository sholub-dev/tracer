import type { UIMessage } from "ai";
import { CLIENT_TOOL_NAMES, findingFromMessages } from "@tracer-sh/shared";
import { isProviderTool } from "./ToolParts";

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

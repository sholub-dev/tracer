import type { JSONValue, ModelMessage } from "ai";
import { CONFIG } from "../config.js";

const KEPT_TOOLS: ReadonlySet<string> = new Set(["report_finding", "begin_analysis"]);
const WRAPPER = "<tool_result>\n";
const STUB_LINES = 6;
const STUB_CHARS = 600;

type Output = { type: string; value?: unknown };
type ResultPart = { type: "tool-result"; toolCallId: string; toolName: string; output: Output };

const isResult = (p: { type: string }): p is ResultPart => p.type === "tool-result";

function outputText(output: Output): string | undefined {
  if (output.type === "text" && typeof output.value === "string") return output.value;
  if (output.type === "json") return JSON.stringify(output.value);
  return undefined;
}

function stub(id: string, title: string, text: string): string {
  const body = text.startsWith(WRAPPER) ? text.slice(WRAPPER.length) : text;
  const first = body.split("\n").slice(0, STUB_LINES).join("\n").slice(0, STUB_CHARS);
  return `Cut from the context to save space. Call read_result with id "${id}" to read it whole before you cite its numbers. ${title}: ${text.split("\n").length} lines. First lines:\n${first}`;
}

/**
 * Replaces old, long tool results with short stubs and keeps each original in `originals`.
 * Results before `questionStart` always shrink; in the question, those issued more than contextKeepSteps
 * assistant messages back at the last watermark move. A stub is shorter than the minimum, so masking twice changes nothing.
 */
export function maskContext(messages: ModelMessage[], questionStart: number, originals: Map<string, string>): ModelMessage[] {
  const { contextKeepSteps, contextMaskEverySteps, contextMaskMinChars } = CONFIG;
  const steps = messages.filter((m, i) => i >= questionStart && m.role === "assistant").length;
  const watermark = Math.floor(steps / contextMaskEverySteps) * contextMaskEverySteps - contextKeepSteps;
  const titles = new Map<string, string>();
  const issuedAt = new Map<string, number>();
  let k = -1;
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    if (i >= questionStart) k++;
    for (const p of m.content) {
      if (p.type !== "tool-call") continue;
      issuedAt.set(p.toolCallId, i >= questionStart ? k : -1);
      titles.set(p.toolCallId, String((p.input as { title?: unknown } | null)?.title || p.toolName));
    }
  });
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    let changed = false;
    const content = m.content.map((p) => {
      if (!isResult(p)) return p;
      const at = issuedAt.get(p.toolCallId);
      if (KEPT_TOOLS.has(p.toolName)) {
        // The copies of cited results serve the card of their own question; a later question reads the stubs.
        const value = p.output.value;
        if (at !== -1 || p.output.type !== "json" || value === null || typeof value !== "object" || !("cited" in value)) return p;
        const { cited: _, ...rest } = value as Record<string, JSONValue>;
        changed = true;
        return { ...p, output: { type: "json" as const, value: rest } };
      }
      if (at === undefined || (at >= 0 && at >= watermark)) return p;
      const text = outputText(p.output);
      if (text === undefined || text.length < contextMaskMinChars) return p;
      originals.set(p.toolCallId, text);
      changed = true;
      return { ...p, output: { type: "text" as const, value: stub(p.toolCallId, titles.get(p.toolCallId) ?? p.toolName, text) } };
    });
    return changed ? { ...m, content } : m;
  });
}

/** The messages with every stubbed result put back, so a reviewer reads what the model first read. */
export function restoreContext(messages: ModelMessage[], originals: Map<string, string>): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    let changed = false;
    const content = m.content.map((p) => {
      const text = isResult(p) ? originals.get(p.toolCallId) : undefined;
      if (text === undefined) return p;
      changed = true;
      return { ...p, output: { type: "text" as const, value: text } };
    });
    return changed ? { ...m, content } : m;
  });
}

/**
 * The whole text of the cut results whose titles `text` names in [brackets], up to `maxChars`; the rest are listed by id.
 * The card cites these, and a number read from a stub or from memory can be wrong.
 */
export function citedOriginals(text: string, messages: ModelMessage[], originals: Map<string, string>, maxChars: number): string | undefined {
  const titles = new Set([...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim().toLowerCase()));
  const ids: { id: string; title: string }[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content) {
      const title = p.type === "tool-call" ? String((p.input as { title?: unknown } | null)?.title ?? "") : "";
      if (p.type === "tool-call" && originals.has(p.toolCallId) && titles.has(title.trim().toLowerCase())) ids.push({ id: p.toolCallId, title });
    }
  }
  if (!ids.length) return undefined;
  let used = 0;
  const shown: string[] = [];
  const listed: string[] = [];
  for (const { id, title } of ids) {
    const body = originals.get(id) ?? "";
    if (used + body.length <= maxChars) {
      shown.push(`${title}:\n${body}`);
      used += body.length;
    } else listed.push(`"${id}" (${title})`);
  }
  return [
    shown.length ? `The chain cites these results, which were cut from the context. Quote their numbers from here:\n\n${shown.join("\n\n")}` : "",
    listed.length ? `Call read_result for these cited results before the card: ${listed.join(", ")}.` : "",
  ].filter(Boolean).join("\n\n");
}

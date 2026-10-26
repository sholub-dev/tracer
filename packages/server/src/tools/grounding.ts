import type { ModelMessage } from "ai";
import { resultText, type StepResult } from "../agents/utility/review.js";
import { WRITE_TOOLS } from "./tool-gate.js";

// Every tool call is a query unless it writes state or only reads another session or a cut result.
export const NON_QUERY_TOOLS: ReadonlySet<string> = new Set([...WRITE_TOOLS, "read_past_session", "read_result"]);
export const MAX_TITLES_LISTED = 8;

export const key = (title: string) => title.trim().toLowerCase();

function failed(output: unknown, text: string): boolean {
  const type = (output as { type?: unknown } | null)?.type;
  return (typeof type === "string" && type.startsWith("error")) || /^Error:/.test(text);
}

/** The full result text of each successful titled query call in the turn, by lowercase title; `stepReads` are the current step's reads, which `messages` lacks. */
export function queryResults(messages: ModelMessage[], originals: ReadonlyMap<string, string>, stepReads: ReadonlyArray<StepResult> = []): Map<string, string> {
  const titles = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content) {
      const title = p.type === "tool-call" ? (p.input as { title?: unknown } | null)?.title : undefined;
      if (p.type === "tool-call" && !NON_QUERY_TOOLS.has(p.toolName) && typeof title === "string" && title.trim()) titles.set(p.toolCallId, title);
    }
  }
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of m.content) {
      const title = p.type === "tool-result" ? titles.get(p.toolCallId) : undefined;
      if (p.type !== "tool-result" || title === undefined) continue;
      const text = originals.get(p.toolCallId) ?? resultText(p.output);
      if (!failed(p.output, text)) out.set(key(title), `${out.get(key(title)) ?? ""}\n${text}`);
    }
  }
  for (const r of stepReads) {
    const title = (r.input as { title?: unknown } | null)?.title;
    if (NON_QUERY_TOOLS.has(r.toolName) || typeof title !== "string" || !title.trim() || failed(undefined, r.text)) continue;
    out.set(key(title), `${out.get(key(title)) ?? ""}\n${r.text}`);
  }
  return out;
}

const PLAIN_NUMBER = /\d+(?:\.\d+)?/g;
const GROUPED_NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/g;

export function resultNumbers(text: string): number[] {
  return [...text.matchAll(PLAIN_NUMBER), ...text.matchAll(GROUPED_NUMBER)].map((m) => Number(m[0].replaceAll(",", "")));
}

// Skips times, dates, numbers in code spans and numbers attached to letters (p95, v2, 5xx); a unit like ms or % may follow.
const CLAIMED_NUMBER = /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:ms|s|min|h|kb|mb|gb|tb|x|%)?(?![\w]|\.\d)/gi;

// A window length is the question's frame, not a measured value.
const WINDOW = /\b\d+-(?:second|minute|hour|day|week|month|min|hr|h|d)s?\b|\b(?:last|past|previous|prior|same|over|first|next)\s+\d+\s?(?:seconds?|minutes?|hours?|days?|weeks?|months?|mins?|hrs?|h|d|w)\b/gi;

export function claimedNumbers(statement: string): { text: string; value: number; decimals: number }[] {
  const plain = statement.replace(/`[^`]*`/g, " ").replace(WINDOW, " ").replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?/g, " ");
  return [...plain.matchAll(CLAIMED_NUMBER)].flatMap((m) => {
    const decimals = m[2] ? m[2].length - 1 : 0;
    if (!decimals && m[1].replaceAll(",", "").length < 2) return [];
    const text = m[1] + (m[2] ?? "");
    return [{ text, value: Number(text.replaceAll(",", "")), decimals }];
  });
}

export function shown(numbers: number[], value: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return numbers.some((r) => r === value || Math.round(r * scale) / scale === value || Math.floor(r * scale) / scale === value);
}

/** Values worked out from two grounded numbers: a difference, a sum, a share or a change in percent. */
export function derived(operands: number[]): number[] {
  const out: number[] = [];
  for (const a of operands) for (const b of operands) {
    if (a === b) continue;
    out.push(Math.abs(a - b), a + b);
    if (b) out.push((a / b) * 100, (Math.abs(a - b) / b) * 100, a / b);
  }
  return out;
}

/** Problems of one cited claim: an unknown source, or a number that none of its cited results shows. `where` names the field. */
export function groundingProblems(where: string, statement: string, sources: string[], results: Map<string, string>, operands: number[] = []): string[] {
  const unknown = sources.filter((s) => !results.has(key(s)));
  const problems = unknown.map((s) => `${where}: source "${s.trim()}" is not the title of a query that succeeded in this turn.${results.size ? ` Titles: ${[...results.keys()].slice(0, MAX_TITLES_LISTED).join("; ")}.` : " No query succeeded."}`);
  if (unknown.length === sources.length) return problems;
  const numbers = sources.flatMap((s) => resultNumbers(results.get(key(s)) ?? ""));
  const claimed = claimedNumbers(statement);
  const grounded = claimed.filter((n) => shown(numbers, n.value, n.decimals)).map((n) => n.value);
  const worked = derived([...grounded, ...operands]);
  return [...problems, ...claimed.filter((n) => !shown(numbers, n.value, n.decimals) && !shown(worked, n.value, n.decimals)).map((n) => `${where}: ${n.text} is not in the result of "${sources.map((s) => s.trim()).join('", "')}".`)];
}

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { UIMessage } from "ai";
import { fromBase64Url, toBase64Url } from "./base64.js";

export const PACKED_PREFIX = "z1:";
/** Rows kept per query result; the chat table shows the same number before "Show all". */
export const MAX_SAVED_ROWS = 100;

const isRecord = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);

/** True when the chat UI draws the rows as a table or list, and not as a chart that needs every row. */
function isCappable(rows: unknown[]): boolean {
  const first = rows[0];
  if (!isRecord(first)) return rows.every((r) => !isRecord(r) && !Array.isArray(r));
  return !("beginTimeSeconds" in first) && !("comparison" in first);
}

/** Caps one query result the way a saved chat does. */
export function capQuery<T>(query: T): T {
  if (!isRecord(query) || !Array.isArray(query.results) || query.results.length <= MAX_SAVED_ROWS || !isCappable(query.results)) return query;
  const totalRows = typeof query.totalRows === "number" ? query.totalRows : query.results.length;
  return { ...query, results: query.results.slice(0, MAX_SAVED_ROWS), totalRows };
}

function capList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  const capped = list.map(capQuery);
  return capped.some((q, i) => q !== list[i]) ? capped : list;
}

function capPart(part: unknown): unknown {
  if (!isRecord(part) || !isRecord(part.output)) return part;
  const { parts, queries } = part.output;
  const nextParts = capList(parts);
  const nextQueries = capList(queries);
  if (nextParts === parts && nextQueries === queries) return part;
  return { ...part, output: { ...part.output, ...(parts ? { parts: nextParts } : {}), ...(queries ? { queries: nextQueries } : {}) } };
}

/** Keeps the first MAX_SAVED_ROWS rows of table-like query results and records the original count as `totalRows`. Safe to repeat. */
export function capQueryRows(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) return message;
    const parts = message.parts.map(capPart);
    return parts.some((p, i) => p !== message.parts[i]) ? ({ ...message, parts } as UIMessage) : message;
  });
}

/** The text stored in chat_sessions.messages: capped rows, deflated, base64url. */
export function encodeMessages(messages: UIMessage[]): string {
  return PACKED_PREFIX + toBase64Url(deflateSync(strToU8(JSON.stringify(capQueryRows(messages)))));
}

export const isPacked = (text: string) => text.startsWith(PACKED_PREFIX);

/** The messages as a JSON string. Reads packed text and legacy plain JSON. */
export function decodeMessagesJson(text: string): string {
  return isPacked(text) ? strFromU8(inflateSync(fromBase64Url(text.slice(PACKED_PREFIX.length)))) : text;
}

export function decodeMessages(text: string): UIMessage[] {
  return JSON.parse(decodeMessagesJson(text)) as UIMessage[];
}

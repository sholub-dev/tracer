/** The tag of the wrapper around a tool result in the model context. */
export const TOOL_RESULT_TAG = "tool_result";

const tagPatterns = new Map<string, RegExp>();

/** Untrusted text for a `<tag>` block: each opening or closing of the tag in it is escaped, in any case and spacing, so the text cannot end the block. */
export function escapeTag(text: string, tag: string): string {
  let re = tagPatterns.get(tag);
  if (!re) tagPatterns.set(tag, re = new RegExp(`<(\\s*/?\\s*${tag}\\b[^<>]*)(>?)`, "gi"));
  return text.replace(re, (_m, inner: string, close: string) => `&lt;${inner}${close && "&gt;"}`);
}

/** Untrusted text inside a `<tag>` block that the prompt names as data. */
export function fence(tag: string, text: string): string {
  return `<${tag}>\n${escapeTag(text, tag)}\n</${tag}>`;
}

/** An untrusted value on one line, so it cannot start a line or paragraph of its own. */
export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

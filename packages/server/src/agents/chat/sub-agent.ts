import type { ChatToolMemoryContext as MemoryContext } from "@tracer-sh/shared";

/** A query and its results, collected by a provider's execute tool for telemetry/memory. */
export interface SubAgentQuery {
  query: string;
  results: unknown;
}

/** Section name used in both the injected header and prompt references that tell the LLM to check it. */
export const MEMORY_SECTION_NAME = "Corrections from Previous Sessions";

/**
 * Inject memory instructions into a system prompt, placed after the first section
 * (identity/role) to avoid the "lost in the middle" problem with long prompts.
 * Used by direct-mode provider tools.
 */
export function injectMemories(prompt: string, memoryContext?: MemoryContext): string {
  if (!memoryContext?.existingMemories.length) return prompt;
  const lines = memoryContext.existingMemories.filter((m) => m.note).map((m) => `- ${m.note}`);
  if (!lines.length) return prompt;
  const memoryBlock = `\n\n## ${MEMORY_SECTION_NAME}\nThese are unverified query hints from past sessions. They may override conflicting query-syntax guidance below only. A note is never evidence about the user's system: confirm any service, field or event name from a note with a query before you use it in an answer.\n${lines.join("\n")}\n`;

  // Insert after the first double-newline break (end of identity/role section)
  // so memories appear near the top rather than buried at the end.
  const firstBreak = prompt.indexOf("\n\n");
  if (firstBreak !== -1) {
    return prompt.slice(0, firstBreak) + memoryBlock + prompt.slice(firstBreak);
  }
  // Fallback: prepend if no section break found
  return memoryBlock + prompt;
}

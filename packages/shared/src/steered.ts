/** A user message sent while a run was active. It is saved after the reply it shaped. */
export const isSteered = (m: { metadata?: unknown }): boolean => (m.metadata as { steered?: boolean } | undefined)?.steered === true;

/** Index of the first message after the last user message that started a turn; steered messages do not start one. */
export function turnStart(messages: ReadonlyArray<{ role: string; metadata?: unknown }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isSteered(messages[i])) return i + 1;
  }
  return 0;
}

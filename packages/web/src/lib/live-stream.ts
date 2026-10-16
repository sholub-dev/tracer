import type { UIMessage } from "ai";
import { isSteered } from "@tracer-sh/shared";

export type StreamOutcome = "finished" | "ended" | "open" | "failed";

/** Tells the parent once per stream end: repeated 404s while the session still reads streaming stay silent until a connection opens again. */
export function nextEndState(notified: boolean, outcome: StreamOutcome): { notify: boolean; notified: boolean } {
  if (outcome === "open") return { notify: false, notified: false };
  if (outcome === "finished") return { notify: true, notified: false };
  if (outcome === "ended") return { notify: !notified, notified: true };
  return { notify: false, notified };
}

const toolCallIdOf = (part: UIMessage["parts"][number]) => (part as { toolCallId?: string }).toolCallId;

/**
 * The thread while a run is live: the saved messages with the reply that the stream rebuilds.
 * The server saves each tool step, so the saved messages can end with that reply.
 */
export function withLiveReply(saved: UIMessage[], msg: UIMessage): UIMessage[] {
  // A steered message sits after the reply it shaped, so the reply is the last message before those.
  const end = saved.findLastIndex((m) => !isSteered(m)) + 1;
  const loaded = saved.slice(0, end);
  const trailing = saved.slice(end);
  const prior = loaded.at(-1)?.role === "assistant" ? loaded.at(-1) : undefined;
  // After a restart the replay holds only the steps the resumed run adds, so the saved steps stay in front of them.
  const rebuilt = new Set(msg.parts.map(toolCallIdOf));
  const continues = prior?.parts.some((p) => {
    const id = toolCallIdOf(p);
    return id !== undefined && !rebuilt.has(id);
  });
  return [...(prior ? loaded.slice(0, -1) : loaded), continues && prior ? { ...msg, parts: [...prior.parts, ...msg.parts] } : msg, ...trailing];
}

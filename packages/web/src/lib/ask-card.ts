import { isSteered, type AskDraft } from "@tracer-sh/shared";

type ThreadMessage = { role: string; parts: ReadonlyArray<{ type: string; text?: string }>; metadata?: unknown };

export type AskState =
  | { status: "open" }
  | { status: "answered"; chosen: number | null }
  | { status: "closed" };

/**
 * State of the ask_user card in `messages[index]`. It is open only on the last
 * assistant reply once that reply is finished; a steered message saved after the
 * reply does not count. A later user message answers it: the option whose label
 * equals that message is chosen, otherwise none.
 */
export function askState(messages: ReadonlyArray<ThreadMessage>, index: number, ask: AskDraft, streaming: boolean): AskState {
  const later = messages.slice(index + 1);
  const answer = later.find((m) => m.role === "user" && !isSteered(m));
  if (answer) {
    const text = answer.parts.map((p) => (p.type === "text" ? p.text ?? "" : "")).join("").trim();
    const chosen = ask.options.findIndex((o) => o.label.trim() === text);
    return { status: "answered", chosen: chosen === -1 ? null : chosen };
  }
  return streaming || later.some((m) => m.role === "assistant") ? { status: "closed" } : { status: "open" };
}

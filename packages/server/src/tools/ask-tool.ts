import { tool, type Tool } from "ai";
import type { UIMessage } from "ai";
import { askUserSchema, CLIENT_TOOL_NAMES, type AskUser } from "@tracer-sh/shared";

/** Ends the reply with a question; the person's answer arrives as their next message. */
export function askUserTool(): Tool<AskUser, "asked"> {
  return tool({
    description: "Ask the person one question and show your options as answer buttons. Use it when the next step is a choice that belongs to the person: going deeper, which of several directions to take, a costly or slow step, or the scope. "
      + "Write options as concrete next actions, short and mutually exclusive. Never ask for a fact you can query. Ask one question, as the last step of the reply and after any analysis, alone in its step. Do not repeat the question in text. "
      + "The reply ends after this call. The person's answer arrives as their next message.",
    inputSchema: askUserSchema,
    execute: async () => "asked" as const,
  });
}

/** True when the reply ends with a question to the person: it is complete, and a resume must not continue it. */
export function endsWithAsk(messages: UIMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.parts.filter((p) => p.type !== "step-start").at(-1)?.type === CLIENT_TOOL_NAMES.ASK_USER;
}

import { tool, type Tool } from "ai";
import type { UIMessage } from "ai";
import { askUserSchema, CLIENT_TOOL_NAMES, type AskUser } from "@tracer-sh/shared";

/** Ends the reply with a question; the person's answer arrives as their next message. */
export function askUserTool(): Tool<AskUser, "asked"> {
  return tool({
    description: "Ask the person one question and show your options as answer buttons. Rarely needed: follow the \"Asking the person\" section of the system prompt for when to ask and how to write the options. "
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

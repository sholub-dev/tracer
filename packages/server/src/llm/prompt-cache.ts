import type { Instructions, UIMessage } from "ai";
import type { ProviderOptions } from "./resolve.js";

const EPHEMERAL = { type: "ephemeral" } as const;

type SentTime = { sentTime?: string };

/** Records when the newest user message was sent, once, so every later turn replays the same text. */
export function stampSentTime(messages: UIMessage[], text: string): UIMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "user" || (last.metadata as SentTime | undefined)?.sentTime) return messages;
  return [...messages.slice(0, -1), { ...last, metadata: { ...(last.metadata as object | undefined), sentTime: text } }];
}

/** Model input only: each stamped user message carries its own send time, keeping history byte-stable for prompt caches. */
export function withSentTimes(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    const sentTime = m.role === "user" ? (m.metadata as SentTime | undefined)?.sentTime : undefined;
    return sentTime ? { ...m, parts: [...m.parts, { type: "text" as const, text: sentTime }] } : m;
  });
}

/**
 * Anthropic gets two cache breakpoints: one on the system prompt (covers tools + system) and
 * the request-level automatic one that tracks the end of the conversation across tool steps.
 */
export function withPromptCaching(
  provider: string,
  systemPrompt: string,
  providerOptions: ProviderOptions,
): { instructions: Instructions; providerOptions: ProviderOptions } {
  if (provider !== "anthropic") return { instructions: systemPrompt, providerOptions };
  return {
    instructions: { role: "system", content: systemPrompt, providerOptions: { anthropic: { cacheControl: EPHEMERAL } } },
    providerOptions: {
      ...providerOptions,
      anthropic: { ...providerOptions?.anthropic, cacheControl: EPHEMERAL },
    },
  };
}

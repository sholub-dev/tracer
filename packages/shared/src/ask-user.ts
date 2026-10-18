import { z } from "zod";

export const MAX_ASK_OPTIONS = 5;

export const askUserSchema = z.object({
  question: z.string().describe("The question, one plain sentence."),
  options: z.array(z.object({
    label: z.string().describe("The answer as a short phrase. It is sent as the person's reply when they press it."),
    detail: z.string().optional().describe("One line that says what this answer leads to. Omit it when the label is clear."),
  })).min(2).max(MAX_ASK_OPTIONS).describe("The answers to offer, each a concrete next action and mutually exclusive."),
});

export type AskUser = z.infer<typeof askUserSchema>;

export interface AskDraft {
  question: string;
  options: Array<{ label: string; detail?: string }>;
}

/** The question and options of an ask_user input as far as it has arrived: a streaming input is partial and shows what it has. */
export function readAskUser(input: unknown): AskDraft {
  const raw = (input && typeof input === "object" ? input : {}) as { question?: unknown; options?: unknown };
  const options = Array.isArray(raw.options) ? raw.options : [];
  return {
    question: typeof raw.question === "string" ? raw.question : "",
    options: options.flatMap((o: { label?: unknown; detail?: unknown } | null) =>
      typeof o?.label === "string" && o.label ? [{ label: o.label, ...(typeof o.detail === "string" && o.detail ? { detail: o.detail } : {}) }] : []),
  };
}

/** Plain text of an ask_user part, for exports and transcripts; empty when no question arrived. */
export function askUserText(input: unknown): string {
  const { question, options } = readAskUser(input);
  return question ? `Question: ${question}${options.length ? `\nOptions: ${options.map((o) => o.label).join(" / ")}` : ""}` : "";
}

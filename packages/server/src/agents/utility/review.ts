import { generateText, type ModelMessage } from "ai";
import { CONFIG } from "../../config.js";
import type { ProviderOptions } from "../../llm/resolve.js";
import { recordEachCall } from "../../llm/usage.js";
import type { Db } from "../../db/driver.js";
import type { Ledger } from "../../tools/analysis-tool.js";
import { truncate } from "./summary.js";

const TOOL_IO_MAX_CHARS = 2000;
const QUESTION_MAX_CHARS = 4000;

const INSTRUCTIONS = `You are a skeptical reviewer of a debugging conclusion. You see only the question, the tool calls with their results, and the agent's ledger. You cannot run queries.

Check each point:
- Every number, identifier and time in the conclusion appears in a result.
- The symptom is verified in the data, not only reported.
- The suspected cause starts before the symptom.
- The suspected cause is new or higher than in a normal window. It is not background noise.
- The suspected cause explains the scale and scope of the symptom: all affected services and endpoints, not a small share.
- No competing explanation is left untested.
- No result that contradicts the conclusion is ignored.
- A pattern seen in 1-2 samples is confirmed with a count before the agent generalizes it.
- The confidence label is not higher than the evidence.

Reply "OK" when you find no problem.
Otherwise list at most 3 problems, most serious first. Write each as one sentence that names the result or the missing check.
Do not suggest fixes for the system under investigation. Do not write a preamble.`;

function userText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/** Compact transcript of the current run: the last user message and everything after it. */
export function buildTranscript(messages: ModelMessage[]): string {
  const start = messages.map((m) => m.role).lastIndexOf("user");
  const question = start >= 0 ? `Question: ${truncate(userText(messages[start]), QUESTION_MAX_CHARS)}\n` : "";
  const lines: string[] = [];
  for (const m of messages.slice(start + 1)) {
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        lines.push(`Agent: ${m.content}`);
        continue;
      }
      for (const p of m.content) {
        if (p.type === "text") lines.push(`Agent: ${p.text}`);
        else if (p.type === "tool-call") lines.push(`Tool call ${p.toolName}: ${truncate(p.input, TOOL_IO_MAX_CHARS)}`);
      }
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type === "tool-result") lines.push(`Result ${p.toolName}: ${truncate(p.output, TOOL_IO_MAX_CHARS)}`);
      }
    }
  }
  // The question frames every check, so a long run loses its oldest steps, not the question.
  const body = lines.join("\n");
  const room = Math.max(0, CONFIG.reviewTranscriptMaxChars - question.length);
  return question + (body.length > room ? body.slice(-room) : body);
}

/** Independent check of a cause conclusion against the run's tool results. Fails open: any error returns null. */
export async function reviewConclusion(
  db: Db,
  sessionId: string,
  model: Parameters<typeof generateText>[0]["model"],
  modelId: string,
  ledger: Ledger,
  messages: ModelMessage[],
  abortSignal: AbortSignal | undefined,
  providerOptions?: ProviderOptions,
): Promise<string | null> {
  if (abortSignal?.aborted) return null;
  // Not AbortSignal.any or AbortSignal.timeout: they need iOS 17.4 and 16, and the app supports iOS 15.
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortSignal!.reason);
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("The review timed out", "TimeoutError")), CONFIG.reviewTimeoutMs);
  try {
    const { text } = await generateText({
      model,
      temperature: 0,
      providerOptions,
      instructions: INSTRUCTIONS,
      messages: [{ role: "user", content: `<run>\n${buildTranscript(messages)}\n</run>\n\n<ledger>\n${JSON.stringify(ledger, null, 2)}\n</ledger>` }],
      abortSignal: controller.signal,
      onLanguageModelCallEnd: recordEachCall(db, sessionId, "review", modelId),
    });
    return text.trim() || null;
  } catch (err) {
    if (!abortSignal?.aborted) console.warn("[review] Failed to review conclusion:", err);
    return null;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

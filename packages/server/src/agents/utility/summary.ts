import { generateText, type UIMessage } from "ai";
import { resolveModel } from "../../llm/resolve.js";
import { extractUsage, recordAgentRun } from "../../llm/usage.js";
import type { Db } from "../../db/client.js";

const SUMMARY_SYSTEM_PROMPT = `You are compacting an AI debugging-assistant conversation into a detailed summary. Your summary will permanently REPLACE the original messages as the assistant's only memory of them, so anything you omit is lost forever. The assistant must be able to continue the investigation from your summary alone without redoing any completed work.

Write the summary as markdown with exactly these sections:

## Original intent
What the user set out to do, in their own framing. Include later refinements or pivots of the goal.

## User requests & decisions
Chronological list of every instruction, question, constraint, correction, and approval or rejection the user gave, and whether each was fulfilled. The assistant must be able to tell from this section alone what the user has and has not asked for.

## Investigation log
Numbered, chronological. Each entry pairs an action with its result:
1. One line on what was done and why, then the exact tool call, query, or API call (with its parameters and the time range it covered) in a fenced code block.

   → Result: what it returned, with the key values verbatim. Render a result with more than one row (facets, top-N lists, table rows) as a markdown table; copy up to roughly 20 rows verbatim and note what was cut.

Never record an action without its result — an unpaired action forces the assistant to re-run it.

## Key findings & data (verbatim)
The distilled facts the investigation established, with exact values copied verbatim — never paraphrase these:
- IDs of any kind (trace IDs, entity GUIDs, account/project IDs, session IDs)
- Exact error messages and stack-trace lines
- File paths, service names, host names, URLs
- Numbers: counts, rates, percentages, latencies, timestamps, time ranges
Do not re-copy queries or result tables that already appear in the Investigation log — state the facts they established and name the log entry they came from.

## What did NOT work (dead ends)
Approaches tried and abandoned, queries that errored or returned empty, hypotheses ruled out — and WHY each failed. This prevents the assistant from repeating them. If nothing failed, write "None."

## Conclusions & current state
Each conclusion the assistant reached, stated together with the evidence supporting it, so it is never re-derived. What was communicated or delivered to the user (answers, recommendations, reports), and any artifacts produced.

## Open items
Unresolved questions, pending next steps, anything the user asked for that has not been delivered yet. If none, write "None."

Rules:
- Be detailed. Length is not a concern; losing information is. A long, precise summary is always better than a short, vague one.
- Copy identifiers, queries, errors, and numbers character-for-character from the conversation.
- Format for scanning: queries and commands go in fenced code blocks, multi-row results in markdown tables, and inline identifiers (service names, error classes, IDs, paths) in backticks.
- State each piece of data in full exactly once, in the section where it belongs; later mentions reference it instead of repeating it.
- Always pair what was run with what it returned.
- If the conversation contains an analysis or post-mortem report (the begin_analysis tool marks where one starts), carry its content through verbatim in the relevant sections instead of re-summarizing it.
- If an existing summary of older messages is provided, merge it with the new segment into ONE self-contained summary covering everything. Preserve all verbatim data from the existing summary unless the new segment explicitly supersedes it.
- Do not add commentary, advice, or information that is not in the conversation.
- Output only the summary markdown, nothing else.`;

// Outputs get a wider window than inputs: they hold the result data the
// summary is required to quote verbatim.
const TOOL_INPUT_CHAR_LIMIT = 2000;
const TOOL_OUTPUT_CHAR_LIMIT = 6000;

// A hung provider request must not pin the client's "summarizing" state forever.
const GENERATION_TIMEOUT_MS = 5 * 60_000;

function truncate(value: unknown, limit: number): string {
  if (value === undefined) return "(none)";
  let text: string;
  try {
    text = typeof value === "string"
      ? value
      // Cap string leaves so a multi-MB query result isn't fully stringified
      // just to keep the first `limit` characters.
      : JSON.stringify(value, (_key, v) =>
          typeof v === "string" && v.length > limit ? v.slice(0, limit) : v,
        );
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}… (truncated)` : text;
}

/**
 * Deterministic text rendering of UIMessages for the summarizer. Text parts are
 * kept verbatim; tool inputs/outputs are truncated per-part so a single huge
 * query result can't dominate the prompt. No global cap — the chat models in
 * use have 200k+ contexts.
 */
export function serializeMessagesForSummary(messages: UIMessage[]): string {
  const blocks: string[] = [];
  messages.forEach((msg, i) => {
    const lines: string[] = [`### Message ${i + 1} — ${msg.role}`];
    for (const part of msg.parts) {
      if (part.type === "text") {
        lines.push(part.text);
        continue;
      }
      // Skip thinking, step markers, transient data parts, and file payloads.
      if (part.type === "reasoning" || part.type === "step-start" || part.type.startsWith("data-") || part.type === "file") {
        continue;
      }
      const p = part as { type: string; toolCallId?: string; input?: unknown; output?: unknown; errorText?: string };
      if (p.toolCallId) {
        const name = p.type.startsWith("tool-") ? p.type.slice(5) : p.type;
        // Failed tool calls (state "output-error") carry the failure in
        // errorText, not output — keep the exact error so dead ends survive.
        const output = p.output !== undefined
          ? p.output
          : p.errorText !== undefined ? `error: ${p.errorText}` : undefined;
        lines.push(
          `[tool: ${name}]`,
          `input: ${truncate(p.input, TOOL_INPUT_CHAR_LIMIT)}`,
          `output: ${truncate(output, TOOL_OUTPUT_CHAR_LIMIT)}`,
        );
      }
    }
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

/**
 * Generate a compaction summary for a slice of session messages. When
 * priorSummary is provided (incremental re-compaction), the model merges it
 * with the new segment into one self-contained summary. Returns an error
 * (config: true for user-fixable model configuration problems) on failure —
 * the caller owns all DB state.
 */
export async function generateSessionSummary(
  db: Db,
  opts: { sessionId: string; priorSummary?: string; messages: UIMessage[]; keptAnalysis?: boolean },
): Promise<{ summary: string } | { error: string; config?: boolean }> {
  const resolved = resolveModel(db);
  if ("error" in resolved) {
    console.warn("[summary] Cannot generate summary:", resolved.error);
    return { error: resolved.error, config: true };
  }

  const serialized = serializeMessagesForSummary(opts.messages);
  let userContent = opts.priorSummary
    ? `## Existing summary of older messages (merge into your output)\n${opts.priorSummary}\n\n## New conversation segment to incorporate\n${serialized}`
    : `## Conversation to summarize\n${serialized}`;
  if (opts.keptAnalysis) {
    // The boundary message's analysis section stays verbatim in the live
    // conversation; the segment ends with its tool work only.
    userContent += `\n\nNote: the assistant's final analysis of the last exchange is preserved verbatim in the conversation right after your summary — record the work and results above without inventing or restating its conclusions.`;
  }

  try {
    const { text, usage } = await generateText({
      model: resolved.model,
      temperature: 0,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      providerOptions: resolved.providerOptions,
      abortSignal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
    const summary = text.trim();
    if (!summary) return { error: "Summary generation returned no content" };
    recordAgentRun(db, {
      sessionId: opts.sessionId,
      agentType: "summary",
      model: resolved.modelId,
      usage: extractUsage(usage, resolved.modelId),
    });
    return { summary };
  } catch (err) {
    console.warn("[summary] Failed to generate summary:", err);
    return { error: "Summary generation failed" };
  }
}

import { streamText, convertToModelMessages, hasToolCall, isStepCount, createUIMessageStream, toUIMessageStream, type UIMessage, type ToolSet, isTextUIPart } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { CLIENT_TOOL_NAMES, DEFAULT_SESSION_TITLE, cardRejected, findingSchema, TOOL_NAMES, unixNow, splitAtAnalysis, findingFromMessages, findingMarkdown, resultRefsToText, turnStart, type AfterCompleteParams, type TokenUsage } from "@tracer-sh/shared";
import { chatSessions } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import { decodeMessages, encodeMessages } from "../lib/messages-codec.js";
import { resolveModel, type ProviderOptions } from "../llm/resolve.js";
import { extractUsage, recordEachCall } from "../llm/usage.js";
import { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import type { Context } from "../trpc/context.js";
import { getCurrentDateBlock, getCurrentTimeText } from "../lib/current-context.js";
import { stampSentTime, withPromptCaching, withSentTimes } from "../llm/prompt-cache.js";
import { ASK_USER_PROMPT, BASE_PROMPT, buildNoProviderPrompt, EVIDENCE_GROUNDING, PLAIN_LANGUAGE } from "../lib/shared-prompts.js";
import { CONFIG, DEFAULTS } from "../config.js";
import { isTransientError } from "../lib/transient.js";
import { createToolGate } from "../tools/tool-gate.js";
import { NON_QUERY_TOOLS } from "../tools/grounding.js";
import { ANALYSIS_TOOL_NAME, createBeginAnalysisTool } from "../tools/analysis-tool.js";
import { drainSteer, newSteerState } from "./steer.js";
import { harnessNote, questionIndex, reviewConclusion, reviewSummary } from "./utility/review.js";
import { MAX_SEND_BACKS, reportFindingTool } from "../tools/finding-tool.js";
import { isSlackSummaryTool, reportAlertSummaryTool } from "../monitors/alert-summary.js";
import { readResultTool } from "../tools/read-result-tool.js";
import { citedOriginals, maskContext, restoreContext } from "./context-mask.js";
import { fence } from "../lib/fence.js";
import { errorLine } from "../lib/error-line.js";

/** Appended to the system prompt only when an attachment is present. */
const IMAGE_ANALYSIS_GUIDANCE = `## Working with attached images and files
The user has attached one or more images or files. Treat each as primary evidence, not decoration:
- Analyze every attachment carefully and in full — do not skim. Inspect fine detail, not just the gist.
- Extract ALL information that could matter: exact error messages and stack traces, status/error codes, log lines, timestamps, numeric values with their units, axis labels and series values on charts/graphs, configuration keys, IDs, and any text visible in screenshots.
- Transcribe values precisely and double-check each reading before relying on it — re-read the image to confirm digits, spelling, and signs rather than approximating.
- Quote what is actually shown rather than paraphrasing loosely, and tie every conclusion back to specific details in the attachment.
- If any part is blurry, cropped, truncated, or ambiguous, say so explicitly and ask — never guess at an unreadable value.`;

export function firstUserMessageTitle(messages: UIMessage[]): string {
  const textPart = messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text");
  return textPart ? (textPart as { text: string }).text.slice(0, 60) : DEFAULT_SESSION_TITLE;
}

/**
 * Move begin_analysis behind the other tool parts of its step: the analysis
 * section is everything after the marker, so queries that ran in the same step
 * as the marker belong before it. The marker step is rarely the last one, and
 * the final save sanitizes the whole reply again, so this looks at the marker's
 * own step, not the last step.
 */
function markAnalysisAfterStepTools(parts: UIMessage["parts"]): UIMessage["parts"] {
  const marker = parts.findIndex((p) => p.type === CLIENT_TOOL_NAMES.BEGIN_ANALYSIS);
  if (marker === -1) return parts;
  let lastTool = -1;
  for (let i = marker + 1; i < parts.length && parts[i].type !== "step-start"; i++) {
    if (typeof (parts[i] as { toolCallId?: unknown }).toolCallId === "string") lastTool = i;
  }
  if (lastTool === -1) return parts;
  return [...parts.slice(0, marker), ...parts.slice(marker + 1, lastTool + 1), parts[marker], ...parts.slice(lastTool + 1)];
}

/**
 * Sanitize messages loaded from the DB so incomplete tool parts (from aborted
 * runs) and stale streaming parts don't break `convertToModelMessages`.
 */
export function sanitizeMessages(messages: UIMessage[]): UIMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const parts = msg.parts
      .map((part) => {
        const p = part as Record<string, unknown>;
        // output-error parts are settled: convertToModelMessages turns them into error results.
        if (p.toolCallId && p.state !== "output-available" && p.state !== "output-error") {
          return { ...p, state: "output-available", output: p.output ?? { error: "Aborted" } };
        }
        return part;
      });
    return { ...msg, parts: markAnalysisAfterStepTools(parts as UIMessage["parts"]) } as UIMessage;
  });
}

export async function loadSessionMessages(
  db: Context["db"],
  sessionId: string,
  newMessage?: UIMessage,
): Promise<{ messages: UIMessage[]; summary: string | null; summaryUpTo: number | null }> {
  const existing = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  let previous: UIMessage[] = [];
  if (existing) {
    try {
      previous = decodeMessages(existing.messages);
    } catch {
      console.warn(`[chat] Corrupted session ${sessionId}, starting fresh`);
    }
  }
  return {
    messages: [...sanitizeMessages(previous), ...(newMessage ? [newMessage] : [])],
    summary: existing?.summary ?? null,
    summaryUpTo: existing?.summaryUpTo ?? null,
  };
}

export interface ChatAgentConfig {
  sessionId: string;
  messages: UIMessage[];
  /** Compaction state from loadSessionMessages — when set and valid, the model
   *  sees [summary in system prompt + messages after the boundary] instead of
   *  the full history. Persistence always keeps the full history. */
  summary?: string | null;
  summaryUpTo?: number | null;
  context: Context;
  collectTools: (sessionId: string) => Promise<{
    tools: Record<string, unknown> | undefined;
    systemPrompt?: string;
    promptFragments?: string[];
    maxSteps?: number;
    providerTypes?: string[];
    afterComplete?: (params: AfterCompleteParams) => void;
  }>;
  sessionTitle: (messages: UIMessage[]) => string;
  /** Wait before each automatic re-run of an attempt that failed with an error; no re-runs when omitted. */
  retryDelaysMs?: readonly number[];
  /** Fires once when the last attempt failed with an error; never on a user stop. */
  onFailed?: (error: string) => void;
  /** Saved with the run so a restart can rebuild it; a run without one is not resumed. */
  scope?: string;
  /** Marks a run a restart resumed, so a second interruption does not resume it again. */
  resumed?: boolean;
  /** The run must end with a finding card: its last step forces the card, and a reply without one gets a repair pass. A chat run leaves the card to the agent. */
  requireFinding?: boolean;
}

/**
 * Idempotent session cleanup: mark done in DB, signal broadcaster, remove from active map.
 * DB update runs first so clients refetching after broadcaster.finish() see status="done".
 */
async function finalizeSession(sessionId: string, context: Context, broadcaster: StreamBroadcaster): Promise<void> {
  if (!context.activeStreams.has(sessionId)) return;
  const markDone = () => context.db
    .update(chatSessions)
    .set({ status: "done", updatedAt: unixNow() })
    .where(eq(chatSessions.id, sessionId))
    .run();
  try {
    // One retry: a row left "streaming" with no run shows as running forever. The desktop driver returns synchronously.
    await Promise.resolve().then(markDone).catch(markDone);
  } catch (err) {
    console.warn(`[chat] Failed to mark ${sessionId} done:`, err);
  } finally {
    sessionChanged(sessionId);
    broadcaster.finish();
    context.activeStreams.delete(sessionId);
  }
}

export const SESSION_BUSY = "Session is already processing a response";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const MAX_ERROR_NOTE_CHARS = 300;

/** Short user-facing note stored on the reply of a run that failed for good. */
function failureNote(err: unknown): string {
  const text = errorText(err).trim();
  const detail = text.length > MAX_ERROR_NOTE_CHARS ? `${text.slice(0, MAX_ERROR_NOTE_CHARS)}...` : text;
  if (!isTransientError(err)) return detail || "The run failed.";
  return detail ? `The run failed after retries: ${detail}` : "The run failed after retries.";
}

/** True when the last step of `msg` ran tools: its results are complete, so a re-run can continue after it. */
function endsWithToolStep(msg: UIMessage | undefined): boolean {
  if (msg?.role !== "assistant") return false;
  const stepStart = msg.parts.map((p) => p.type).lastIndexOf("step-start");
  return msg.parts.slice(stepStart + 1).some((part) => {
    const p = part as { toolCallId?: unknown; state?: unknown };
    return typeof p.toolCallId === "string" && (p.state === "output-available" || p.state === "output-error");
  });
}

const READ_RESULT_TOOL = "read_result";

/** True for a card that was shown: recorded, or saved before the output said so (a valid card and no error). An aborted or sent-back card is not. */
function cardRecorded(input: unknown, output: unknown): boolean {
  if (cardRejected(output)) return false;
  const o = output as { recorded?: unknown; error?: unknown } | null | undefined;
  if (o?.recorded === true) return true;
  return o != null && o.error === undefined && findingSchema.safeParse(input).success;
}

/** Names of the tool calls in the reply to the newest user message; a finding call that was not recorded does not count. */
export function turnToolNames(messages: UIMessage[]): string[] {
  return messages.slice(turnStart(messages)).flatMap((msg) => msg.parts.flatMap((part) => {
    const p = part as { type: string; toolName?: string; state?: string; input?: unknown; output?: unknown };
    const name = p.type === "dynamic-tool" ? p.toolName : p.type.startsWith("tool-") ? p.type.slice(5) : undefined;
    return name && !(name === TOOL_NAMES.FINDING && (p.state !== "output-available" || !cardRecorded(p.input, p.output))) ? [name] : [];
  }));
}

type StepCalls = { toolResults: { toolName: string; input?: unknown; output: unknown }[] }[];

const cardShown = ({ steps }: { steps: StepCalls }) => stepToolNames(steps).includes(TOOL_NAMES.FINDING);

/** Names of the tool calls in this attempt's finished steps; a card that was not recorded does not count. */
function stepToolNames(steps: StepCalls): string[] {
  return steps.flatMap((s) => s.toolResults.flatMap((r) => (r.toolName === TOOL_NAMES.FINDING && !cardRecorded(r.input, r.output) ? [] : [r.toolName])));
}

/** True when a query ran and no finding card followed. */
export function owesFinding(toolNames: string[]): boolean {
  // A question to the person ends the reply on purpose, so it is a valid end without a card.
  if (toolNames.includes(TOOL_NAMES.ASK_USER)) return false;
  return toolNames.some((name) => !NON_QUERY_TOOLS.has(name)) && !toolNames.includes(TOOL_NAMES.FINDING);
}

/** The model cannot see its step count, so a deep investigation would spend the budget before its analysis and review. */
export function budgetNote(stepNumber: number, maxSteps: number, toolNames: string[], requireFinding: boolean): string | undefined {
  if (!owesFinding(toolNames)) return undefined;
  const reserve = Math.ceil(maxSteps / 10);
  if (stepNumber === maxSteps - 1) {
    return requireFinding
      ? "This is the last step. Call report_finding now from the results you have. State only what the results show, set the confidence label to match, and state in unknown the open why you did not reach."
      : "This is the last step, and no query tools remain. Answer now from the results you have with report_finding, or in text when the answer is one fact. State only what the results show, and name the open question you did not reach.";
  }
  if (reserve > 1 && stepNumber === maxSteps - reserve) {
    if (!requireFinding) return `At this point ${reserve} steps remained in this reply. Finish the link you are on, then answer from the results you have.`;
    const analyzed = toolNames.includes(TOOL_NAMES.BEGIN_ANALYSIS);
    return `At this point ${reserve} steps remained in this reply. Finish the link you are on, ${analyzed ? "settle the challenges" : "call begin_analysis"}, then write the card. State the next open link in unknown.`;
  }
  return undefined;
}

/** A finished reply that still owes its finding card, and the follow-up work that waits for it. The repair pass collects fresh tools, so the first pass's `afterComplete` keeps the queries it gathered. */
type Owed = { messages: UIMessage[]; finish: () => void; afterComplete?: (params: AfterCompleteParams) => void };
type AttemptResult = { error?: string; transient?: boolean; checkpoint?: UIMessage[]; owed?: Owed };

/** Resolves after `ms`, or at once when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** What stays the same across the attempts of one run. */
interface RunConfig {
  sessionId: string;
  context: Context;
  broadcaster: StreamBroadcaster;
  serverAbort: AbortController;
  collectTools: ChatAgentConfig["collectTools"];
  sessionTitle: ChatAgentConfig["sessionTitle"];
  model: Parameters<typeof streamText>[0]["model"];
  provider: string;
  modelId: string;
  providerOptions: ProviderOptions;
  compaction: { summary?: string | null; summaryUpTo?: number | null };
  /** Whether the run must end with a finding card. */
  requireFinding: boolean;
}

interface AttemptOptions {
  history: UIMessage[];
  final: boolean;
  /** Steps the reply held when the run began: a continued reply starts a fresh budget, a re-run attempt keeps spending the same one. */
  budgetFrom: number;
  /** The one extra pass that adds the finding card a finished turn still owes. */
  repair?: Owed;
}

/**
 * Background LLM processing — runs completely independent of the HTTP response.
 * Emits stream parts to the broadcaster; saves messages to DB after each tool step and on completion.
 * Returns the error of a failed attempt and the messages of its last saved step, which a re-run continues from.
 * A failed last attempt and a stopped run still save the reply they produced.
 */
async function processLLMStream(
  run: RunConfig,
  { history: messages, final, budgetFrom, repair }: AttemptOptions,
): Promise<AttemptResult> {
  const { sessionId, context, broadcaster, serverAbort, collectTools, sessionTitle, model, provider, modelId, providerOptions, compaction, requireFinding } = run;
  const collected = await collectTools(sessionId);
  // One gate per attempt: it holds the tool calls of a step to the read limit and runs writes alone.
  // The run's own model reviews the conclusion; swap the tool before gating so it stays a gated write.
  // The repair pass and the last step have no step left to fix a sent-back summary or to write a ledger for the card.
  let lastStep: boolean = !!repair;
  const gate = createToolGate();
  const collectedTools = collected.tools;
  // The original text of each result cut from the model input, for read_result and the reviewers.
  const originals = new Map<string, string>();
  const reviewed = collectedTools && {
    ...collectedTools,
    [READ_RESULT_TOOL]: readResultTool(originals),
    ...(ANALYSIS_TOOL_NAME in collectedTools && {
      [ANALYSIS_TOOL_NAME]: createBeginAnalysisTool(
        (ledger, msgs, signal) => reviewConclusion(context.db, sessionId, model, modelId, ledger, restoreContext(msgs, originals), signal, providerOptions, questionStart, Object.keys(collectedTools), gate.stepReads()),
        (ledger, msgs) => citedOriginals(`${ledger.chain ?? ""} ${ledger.causeEvidence ?? ""}`, msgs, originals, CONFIG.citedResultsMaxChars),
        originals,
        () => questionStart,
        gate.stepReads,
      ),
    }),
    ...(TOOL_NAMES.FINDING in collectedTools && { [TOOL_NAMES.FINDING]: reportFindingTool(originals, () => questionStart, () => ANALYSIS_TOOL_NAME in collectedTools, () => lastStep, gate.stepReads) }),
    ...(isSlackSummaryTool(collectedTools[TOOL_NAMES.ALERT_SUMMARY]) && { [TOOL_NAMES.ALERT_SUMMARY]: reportAlertSummaryTool({ slack: true }, (summary, msgs, signal) => reviewSummary(context.db, sessionId, model, modelId, summary, restoreContext(msgs, originals), signal, providerOptions, questionStart, gate.stepReads()), () => questionStart, () => lastStep) }),
  };
  const tools = reviewed && gate(reviewed);

  // Compaction: when the session has a summary, the model sees only
  // [summary in system prompt + messages after the boundary]. The full
  // history below (`messages`) still flows to originalMessages/persistence
  // untouched — compaction never alters what is stored.
  let modelInput = messages;
  let summaryForPrompt: string | null = null;
  if (compaction.summary && compaction.summaryUpTo && compaction.summaryUpTo < messages.length) {
    const tail = messages.slice(compaction.summaryUpTo);
    if (tail[0].role === "user") {
      modelInput = tail;
      summaryForPrompt = compaction.summary;
    } else {
      // Kept analysis boundary: the summary already covers its tool work, so
      // only the analysis section rides along, opened by a synthetic user turn
      // (the model conversation must start with a user message). Model input
      // only — never persisted. If the boundary has no usable analysis
      // section, this isn't a valid kept-analysis boundary — fall through to
      // the stale-boundary warning below rather than re-send the whole turn
      // the summary already covers.
      const split = splitAtAnalysis(tail[0].parts);
      if (split && split.analysis.length > 0) {
        tail[0] = { ...tail[0], parts: split.analysis };
        modelInput = [
          { id: "", role: "user" as const, parts: [{ type: "text" as const, text: "(The conversation up to this point was compacted into the summary in your instructions.)" }] },
          ...tail,
        ];
        summaryForPrompt = compaction.summary;
      }
    }
  }
  if (compaction.summary && !summaryForPrompt) {
    // Stale or odd boundary (e.g. history edited): fall back to full history,
    // but leave a trace — the UI still shows the summary as active.
    console.warn(`[chat] Ignoring stale compaction boundary for ${sessionId} (summaryUpTo=${compaction.summaryUpTo}, messages=${messages.length})`);
  }

  // Clock time rides on user turns, not the system prompt, so the prompt stays cacheable.
  const modelMessages = await convertToModelMessages(withSentTimes(modelInput), {
    tools: tools as ToolSet | undefined,
    convertDataPart: () => undefined,
  });

  let systemPrompt: string;
  if (collected.systemPrompt) {
    systemPrompt = collected.systemPrompt;
  } else {
    const fragments = collected.promptFragments ?? [];
    systemPrompt = fragments.length > 0
      ? `${BASE_PROMPT}\n\n${EVIDENCE_GROUNDING}\n\n${PLAIN_LANGUAGE}\n\n${fragments.join("\n\n")}`
      : buildNoProviderPrompt();
  }

  systemPrompt += "\n\n" + await getCurrentDateBlock(context.db, collected.providerTypes);

  if (tools && TOOL_NAMES.ASK_USER in tools) systemPrompt += "\n\n" + ASK_USER_PROMPT;

  if (modelInput.some((m) => m.parts.some((p) => p.type === "file"))) {
    systemPrompt += "\n\n" + IMAGE_ANALYSIS_GUIDANCE;
  }

  if (summaryForPrompt) {
    systemPrompt += `\n\n## Earlier conversation summary\nThe earlier part of this conversation was compacted to save context. The summary below replaces those messages: the work it describes is already done — do NOT redo it. Reuse its identifiers and queries. Its numbers are second-hand: re-run the query before you quote a number in a finding card. Its conclusions are earlier claims: keep them while the data agrees, and test them again when a new result contradicts them.\n\n${fence("conversation_summary", summaryForPrompt)}`;
  }

  const questionStart = questionIndex(modelInput, modelMessages);

  // A re-run or repair pass starts from the saved reply, which lacks the messages sent during the run.
  const steer = context.activeStreams.get(sessionId)?.steer;
  if (steer?.steered.length) modelMessages.push(...await convertToModelMessages(withSentTimes(steer.steered), { convertDataPart: () => undefined }));

  // The nudge is model input only, so the saved reply does not gain a user turn.
  if (repair) modelMessages.push(harnessNote(`Call ${TOOL_NAMES.FINDING} now with the answer to the question.`));

  const cached = withPromptCaching(provider, systemPrompt, providerOptions);
  const maxSteps = collected.maxSteps ?? DEFAULTS.directModeMaxSteps;
  // The repair pass only adds the card, so nothing follows it.
  const lastMessage = messages.at(-1);
  const replySteps = lastMessage?.role === "assistant" ? lastMessage.parts.filter((p) => p.type === "step-start").length : 0;
  const spent = repair ? 0 : Math.max(0, replySteps - budgetFrom);
  // The repair pass gets more steps only to fix cards the check sent back.
  const stepLimit = repair ? 1 + MAX_SEND_BACKS : Math.max(1, maxSteps - spent);
  const canReport = tools !== undefined && TOOL_NAMES.FINDING in tools;
  // Anthropic extended thinking rejects a forced tool choice; activeTools alone still works.
  const mayForceTool = provider !== "anthropic" || !providerOptions?.anthropic?.thinking;
  const forceCard = { activeTools: [TOOL_NAMES.FINDING], ...(mayForceTool ? { toolChoice: { type: "tool" as const, toolName: TOOL_NAMES.FINDING } } : {}) };
  // `step` counts the steps of the reply since the run began, across re-run attempts.
  const toolsForStep = (step: number, steps: StepCalls) => {
    if (repair) return forceCard;
    // The last step must carry the answer, or a turn that spent its budget on queries ends on a tool call.
    if (step !== maxSteps - 1) return undefined;
    const names = [...turnToolNames(messages), ...stepToolNames(steps)];
    if (!owesFinding(names)) return undefined;
    // A chat run may answer in text: only the query tools go, nothing is forced.
    return requireFinding ? forceCard : { activeTools: [TOOL_NAMES.FINDING] };
  };
  // Ends only this attempt (a silent stream), unlike serverAbort, which is a stop of the whole run.
  // Not AbortSignal.any: it needs iOS 17.4, and the app supports iOS 15. A stop of the run also ends the attempt.
  const attemptAbort = new AbortController();
  const onRunAbort = () => attemptAbort.abort(serverAbort.signal.reason);
  if (serverAbort.signal.aborted) onRunAbort();
  else serverAbort.signal.addEventListener("abort", onRunAbort, { once: true });
  const result = streamText({
    model,
    temperature: 0,
    instructions: cached.instructions,
    messages: modelMessages,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    // A question to the person ends the reply; their answer starts the next turn. An accepted card ends a chat reply;
    // a monitor run still calls its triage and Slack tools after the card.
    stopWhen: tools ? [isStepCount(stepLimit), hasToolCall(TOOL_NAMES.ASK_USER), ...(repair || !requireFinding ? [cardShown] : [])] : undefined,
    prepareStep: async ({ stepNumber, steps, messages: carried }) => {
      gate.startStep();
      // Masking is idempotent and the returned messages carry forward, so each step masks only what the watermark newly passed.
      const stepMessages = maskContext(carried, questionStart, originals);
      const step = spent + stepNumber;
      // The returned messages carry forward to later steps.
      // A step adds one step-start part to the reply, so the step number counts the boundaries; a continued reply already holds some.
      const anchor = replySteps + stepNumber;
      const arrived = steer ? drainSteer(steer, anchor) : [];
      // Lets the client tell a message a step saw from one that arrived too late.
      if (arrived.length) broadcaster.emit({ type: "data-steer-seen", data: { ids: arrived.map((m) => m.id), anchor }, transient: true });
      const added = arrived.length
        ? { messages: [...stepMessages, ...await convertToModelMessages(withSentTimes(arrived), { convertDataPart: () => undefined })] }
        : undefined;
      lastStep = !!repair || step >= maxSteps - 1;
      const forTools = canReport ? toolsForStep(step, steps) : undefined;
      const note = canReport && !repair ? budgetNote(step, maxSteps, [...turnToolNames(messages), ...stepToolNames(steps)], requireFinding) : undefined;
      const withNote = note ? { messages: [...(added?.messages ?? stepMessages), harnessNote(note)] } : added;
      return { messages: stepMessages, ...withNote, ...forTools };
    },
    providerOptions: cached.providerOptions,
    abortSignal: attemptAbort.signal,
    // Without a handler the SDK prints the whole error object, with the request body.
    onError: ({ error }) => console.warn(`[chat] Model error for ${sessionId}:`, errorLine(error)),
    onLanguageModelCallEnd: recordEachCall(context.db, sessionId, "chat", modelId),
  });

  // Promise that resolves when the detached persistence IIFE in onEnd completes.
  // Gates the fallback cleanup so processLLMStream doesn't return prematurely.
  let resolveFinish!: () => void;
  const finishPromise = new Promise<void>((r) => { resolveFinish = r; });
  let failure: unknown;
  let streamError: unknown;
  let errorSent = false;
  let runaway: Error | undefined;
  let stall: Error | undefined;
  let saveFailure: unknown;
  let checkpoint: UIMessage[] | undefined;
  let stepSaved = false;
  let owed: Owed | undefined;
  let settled = false;
  let stepSave: Promise<void> = Promise.resolve();
  // The model stream can end before the wrapper runs its last step save, so the final save waits for the read loop too.
  let readDone!: () => void;
  const readEnd = new Promise<void>((r) => { readDone = r; });

  const modelStream = toUIMessageStream({
    stream: result.stream,
    tools: tools as ToolSet | undefined,
    sendStart: false,
    originalMessages: messages,
    onError: (err) => {
      streamError ??= err;
      return "An error occurred.";
    },
    onEnd: ({ messages: updatedMessages, outcome, finishReason }) => {
      // A mid-stream model error still ends with "finish", so only its finish reason shows the failure.
      const failed = stall !== undefined || runaway !== undefined || outcome.status === "failed" || finishReason === "error";
      if (failed) {
        failure = stall ?? runaway ?? (outcome.status === "failed" ? outcome.error : undefined) ?? streamError ?? new Error("The model stream failed");
        // A re-run continues from the last saved step, so an attempt that will be re-run saves no more. The reasoning cap is not re-run.
        if (!final && runaway === undefined && isTransientError(failure)) {
          resolveFinish();
          return;
        }
      }
      // onEnd is synchronous but usage requires an await, so full
      // persistence runs in a detached IIFE to avoid blocking the stream close.
      (async () => {
        try {
          await readEnd;
          await stepSave;
          // Usage rejects when the run was stopped or failed; the reply is still worth saving.
          let chatUsage: TokenUsage | undefined;
          try {
            chatUsage = extractUsage(await result.usage, modelId);
          } catch { /* no usage to record */ }

          let toSave = updatedMessages;
          if (failed) {
            // A re-run continues the saved reply, so the last message can be that reply with no new parts.
            const last = updatedMessages.at(-1);
            const reply = last?.role === "assistant" ? last : undefined;
            if (!reply || reply.parts.length === 0) {
              // A message a step already saw stays in the history.
              toSave = steer?.steered.length ? [...messages] : messages;
            } else {
              const metadata = { ...(reply.metadata as object | undefined), error: runaway ? runaway.message : failureNote(failure) };
              toSave = [...updatedMessages.slice(0, -1), { ...reply, metadata }];
            }
          }
          if (toSave === messages) {
            // A first message that failed still gets a title from its text.
            await context.db
              .update(chatSessions)
              .set({ title: sessionTitle(messages) })
              .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.title, DEFAULT_SESSION_TITLE)))
              .run();
            sessionChanged(sessionId);
            return;
          }

          // sanitizeMessages settles a stopped or failed reply that ends inside a tool call, so it does not show as still running.
          const enrichedMessages = sanitizeMessages(toSave).map((msg, i) =>
            msg.role === "assistant" && i === toSave.length - 1 ? { ...msg, usage: chatUsage } : msg);

          const title = sessionTitle(enrichedMessages);
          // A stopped or failed reply gets no repair pass. While one is owed the row stays "streaming"; finalizeSession writes "done".
          const owesCard = !settled && !failed && !serverAbort.signal.aborted && canReport && requireFinding && !repair && owesFinding(turnToolNames(enrichedMessages));
          const now = unixNow();
          const packed = encodeMessages([...enrichedMessages, ...(steer?.steered ?? [])]);

          await context.db
            .insert(chatSessions)
            .values({
              id: sessionId,
              title,
              messages: packed,
              status: owesCard ? "streaming" : "done",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: chatSessions.id,
              set: {
                title: sql`CASE WHEN ${chatSessions.title} = ${DEFAULT_SESSION_TITLE} THEN ${title} ELSE ${chatSessions.title} END`,
                messages: packed,
                ...(owesCard ? {} : { status: sql`CASE WHEN ${chatSessions.status} = 'idle' THEN 'idle' ELSE 'done' END` }),
                updatedAt: now,
              },
            })
            .run();
          sessionChanged(sessionId);

          const afterComplete = repair?.afterComplete ?? collected.afterComplete;
          const finish = () => {
            if (!afterComplete) return;
            const lastWithText = (role: string) => enrichedMessages.filter((m) => m.role === role && m.parts.some(isTextUIPart)).at(-1);
            // The last text part of a reply is its answer; the first can be a note before a tool call.
            const answer = lastWithText("assistant")?.parts.filter(isTextUIPart).at(-1);
            const question = lastWithText("user")?.parts.find(isTextUIPart);
            let lastAssistantText = answer ? resultRefsToText(answer.text) : "";
            // The card is the answer; the first text part is only a note before it.
            const finding = findingFromMessages(enrichedMessages.slice(turnStart(enrichedMessages)));
            if (finding) lastAssistantText = findingMarkdown(finding);
            afterComplete({ lastUserMessage: question ? question.text : "", lastAssistantText, sessionId });
          };
          // A stopped reply is partial; follow-up work (e.g. a monitor's report) waits for a full run.
          if (!failed && !serverAbort.signal.aborted) {
            // The repair pass runs next and follow-up work waits for its reply; a save that outlived the wait below gets no repair pass.
            if (owesCard && !settled) owed = { messages: enrichedMessages, finish, afterComplete: collected.afterComplete };
            else {
              // The wait gave up during the write above. Once finalizeSession has run, nothing else ends "streaming".
              if (owesCard && !context.activeStreams.has(sessionId)) {
                await context.db.update(chatSessions).set({ status: "done" }).where(eq(chatSessions.id, sessionId)).run();
                sessionChanged(sessionId);
              }
              finish();
            }
          }
        } catch (err) {
          console.warn(`[chat] Failed to save session ${sessionId}:`, errorLine(err));
          saveFailure = err;
        } finally {
          resolveFinish();
        }
      })();
    },
  });

  // The wrapper waits for each step save before it passes the step end on.
  const uiStream = createUIMessageStream({
    originalMessages: messages,
    // Saved replies have an empty id, as the final save writes them; a step save must match.
    generateId: () => "",
    execute: ({ writer }) => writer.merge(modelStream),
    // A throw from the model stream ends here instead of in the read loop below.
    onError: (err) => {
      failure ??= err;
      streamError ??= err;
      return "An error occurred.";
    },
    // Each finished tool step is saved, so a failure later in the run keeps the tool work.
    onStepEnd: async ({ messages: stepMessages }) => {
      if (!endsWithToolStep(stepMessages.at(-1))) return;
      // A re-run continues from this step even when the write fails, so viewers keep it too.
      checkpoint = stepMessages;
      stepSaved = true;
      stepSave = (async () => {
        try {
          await context.db
            .update(chatSessions)
            .set({ messages: encodeMessages([...sanitizeMessages(stepMessages), ...(steer?.steered ?? [])]), updatedAt: unixNow() })
            .where(eq(chatSessions.id, sessionId))
            .run();
        } catch (err) {
          console.warn(`[chat] Failed to save a step of ${sessionId}:`, err);
        }
      })();
      await stepSave;
    },
  });

  // This loop runs independently of any HTTP connection.
  const reader = uiStream.getReader();
  let reasoningChars = 0; // per-step; code-level guard against runaway thinking loops
  // A dead connection (e.g. after the app was suspended) never errors; without this the run would hold its session for ever.
  // A running tool is silent by nature, so its time does not count.
  const runningTools = new Set<string>();
  try {
    while (true) {
      let silence: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<"silent">((resolve) => {
          if (runningTools.size === 0) silence = setTimeout(() => resolve("silent"), CONFIG.chatStreamStallMs);
        }),
      ]).finally(() => clearTimeout(silence));
      if (next === "silent") {
        stall = new Error(`The model stream was silent for ${CONFIG.chatStreamStallMs / 1000}s`);
        failure = stall;
        attemptAbort.abort(stall);
        break;
      }
      const { done, value } = next;
      if (done) break;
      const v = value as Record<string, unknown>;
      if (typeof v.toolCallId === "string") {
        if (v.type === "tool-input-available") runningTools.add(v.toolCallId);
        else if (typeof v.type === "string" && /^tool-(output|input-error)/.test(v.type)) runningTools.delete(v.toolCallId);
      }
      if (v.type === "start-step") {
        reasoningChars = 0;
      } else if (v.type === "reasoning-delta" && typeof v.delta === "string") {
        reasoningChars += v.delta.length;
        if (reasoningChars > CONFIG.maxReasoningCharsPerStep) {
          console.warn(`[chat] reasoning exceeded ${CONFIG.maxReasoningCharsPerStep} chars in one step — aborting ${sessionId}`);
          runaway = new Error(`The model reasoned past ${CONFIG.maxReasoningCharsPerStep} characters in one step`);
          serverAbort.abort();
          break;
        }
      }
      // A re-run follows a transient failure, so the client should not show this attempt's error.
      if (v.type === "error") {
        if (!final && (streamError === undefined || isTransientError(streamError))) continue;
        errorSent = true;
      }
      // Strip providerMetadata — the AI SDK emits it on some event types
      // but its own strictObject schema rejects it on the client side.
      const { providerMetadata: _, ...clean } = v;
      broadcaster.emit(clean);
      // A re-run drops only what came after the last saved step.
      if (v.type === "finish-step" && stepSaved) {
        broadcaster.mark();
        stepSaved = false;
      }
    }
  } catch (err) {
    console.warn(`[chat] Stream error for ${sessionId}:`, errorLine(err));
    failure ??= err;
  } finally {
    serverAbort.signal.removeEventListener("abort", onRunAbort);
    reader.releaseLock();
    readDone();
  }

  // Wait for onEnd persistence to complete.
  // If the stream was aborted before onEnd could fire, use a timeout fallback.
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((r) => { timeoutId = setTimeout(r, 5000); });
  await Promise.race([finishPromise, timeout]);
  settled = true;
  clearTimeout(timeoutId!);
  // The reasoning cap is the server's own stop, so the run failed; a stop by the user is not a failure.
  if (runaway) {
    broadcaster.emit({ type: "error", errorText: "An error occurred." });
    return { error: runaway.message, transient: false };
  }
  // A reply that could not be saved is lost, and the follow-up work never ran; a re-run would repeat the model work for the same save.
  if (saveFailure !== undefined && failure === undefined && !serverAbort.signal.aborted) {
    broadcaster.emit({ type: "error", errorText: "An error occurred." });
    return { error: errorText(saveFailure), transient: false };
  }
  if (serverAbort.signal.aborted || failure === undefined) return { owed };
  const transient = isTransientError(failure);
  // A dropped connection throws instead of sending an error part; clients need one to show Retry.
  if ((final || !transient) && !errorSent) broadcaster.emit({ type: "error", errorText: "An error occurred." });
  return { error: errorText(failure), transient, checkpoint };
}

export async function runChatAgent({
  sessionId, messages: incoming, summary, summaryUpTo, context, collectTools, sessionTitle, retryDelaysMs = [], onFailed, scope, resumed, requireFinding = false,
}: ChatAgentConfig) {
  const [timeText, resolved] = await Promise.all([getCurrentTimeText(context.db), resolveModel(context.db)]);
  const messages = stampSentTime(incoming, timeText);
  if ("error" in resolved) return { error: resolved.error };
  const { model, provider, modelId, providerOptions } = resolved;

  // Prevent concurrent streams on the same session
  if (context.activeStreams.has(sessionId)) {
    return { error: SESSION_BUSY };
  }

  // Create server-owned abort controller + broadcaster
  const serverAbort = new AbortController();
  const broadcaster = new StreamBroadcaster();
  context.activeStreams.set(sessionId, { broadcaster, controller: serverAbort, steer: newSteerState() });

  try {
    const now = unixNow();
    const packed = encodeMessages(messages);
    await context.db
      .insert(chatSessions)
      .values({
        id: sessionId,
        title: DEFAULT_SESSION_TITLE,
        messages: packed,
        status: "streaming",
        runScope: scope ?? null,
        resumed: resumed ? 1 : 0,
        createdAt: now,
        updatedAt: now,
        activeAt: now,
      })
      .onConflictDoUpdate({
        target: chatSessions.id,
        // A resumed run continues the trigger that started it, so the session keeps its place in the list.
        set: { messages: packed, status: "streaming", runScope: scope ?? null, resumed: resumed ? 1 : 0, updatedAt: now, ...(resumed ? {} : { activeAt: now }) },
      })
      .run();
  } catch (err) {
    broadcaster.finish();
    context.activeStreams.delete(sessionId);
    throw err;
  }
  sessionChanged(sessionId);

  // Start LLM processing in background — completely decoupled from HTTP lifecycle.
  // If the HTTP response is cancelled (client navigates away), this continues running.
  // The session stays active between attempts, so nothing else starts a run on it.
  const run: RunConfig = { sessionId, context, broadcaster, serverAbort, collectTools, sessionTitle, model, provider, modelId, providerOptions, compaction: { summary, summaryUpTo }, requireFinding };
  (async () => {
    // Each re-run continues from the last saved step of the attempts before it.
    let history = messages;
    const last = messages.at(-1);
    const budgetFrom = last?.role === "assistant" ? last.parts.filter((p) => p.type === "step-start").length : 0;
    // A throw before the model call (tool setup, history conversion) is a failed attempt too, so it is retried and reported.
    const attemptFailed = (final: boolean) => (err: unknown): AttemptResult => {
      if (serverAbort.signal.aborted) return {};
      const transient = isTransientError(err);
      // Clients need an error part to show Retry, as for a failure inside the stream.
      if (final || !transient) broadcaster.emit({ type: "error", errorText: "An error occurred." });
      return { error: errorText(err), transient };
    };
    for (let attempt = 0; ; attempt++) {
      const final = attempt >= retryDelaysMs.length;
      const { error, transient, checkpoint, owed } = await processLLMStream(run, { history, final, budgetFrom }).catch(attemptFailed(final));
      if (error === undefined) {
        if (!owed) break;
        // One extra pass on the saved reply, never repeated.
        const repaired = await processLLMStream(run, { history: owed.messages, final: false, budgetFrom: 0, repair: owed }).catch(attemptFailed(false));
        if (repaired.error !== undefined) {
          console.warn(`[chat] Finding pass for ${sessionId} failed:`, repaired.error);
          // Clients drop what the failed pass streamed after the last saved step.
          if (repaired.transient) broadcaster.rewind({ type: "reset-step" });
          // The reply before this pass was complete, so its follow-up work still runs.
          owed.finish();
        }
        break;
      }
      if (checkpoint) history = checkpoint;
      if (!final && transient) {
        broadcaster.rewind({ type: "reset-step" });
        console.warn(`[chat] Attempt ${attempt + 1} for ${sessionId} failed, retrying in ${retryDelaysMs[attempt] / 1000}s:`, error);
        await delay(retryDelaysMs[attempt], serverAbort.signal);
        // A user stop during the wait is not a failure.
        if (serverAbort.signal.aborted) break;
      }
      if (final || !transient) {
        console.warn(`[chat] Run for ${sessionId} failed:`, error);
        onFailed?.(error);
        break;
      }
    }
  })().catch((err) => {
    console.error(`[chat] Unhandled error in LLM processing for ${sessionId}:`, errorLine(err));
  }).finally(() => {
    // After the DB write so clients reloading on "done" read the final messages.
    finalizeSession(sessionId, context, broadcaster).catch((err) => {
      console.error(`[chat] Failed to finalize ${sessionId}:`, err);
    });
  });

  // HTTP response stream: subscribes to the broadcaster and forwards events.
  // When client disconnects, only this stream tears down — LLM processing is unaffected.
  const stream = createUIMessageStream({
    execute: ({ writer: sdkWriter }) => {
      return new Promise<void>((resolve) => {
        const unsub = broadcaster.subscribe((part) => {
          sdkWriter.write(part as Parameters<typeof sdkWriter.write>[0]);
        });
        const unDone = broadcaster.onDone(() => {
          unsub();
          unDone();
          resolve();
        });
        // If broadcaster is already done (race condition), resolve immediately
        if (broadcaster.done) {
          unsub();
          unDone();
          resolve();
        }
      });
    },
  });

  return { stream };
}

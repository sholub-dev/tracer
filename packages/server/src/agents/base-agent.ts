import { streamText, convertToModelMessages, isStepCount, createUIMessageStream, toUIMessageStream, type UIMessage, type ToolSet } from "ai";
import { eq, sql } from "drizzle-orm";
import { CLIENT_TOOL_NAMES, DEFAULT_SESSION_TITLE, unixNow, splitAtAnalysis, mergeProgressPart, type AfterCompleteParams, type ProgressPart, type TokenUsage } from "@tracer-sh/shared";
import { chatSessions } from "../db/schema.js";
import { sessionChanged } from "../lib/session-events.js";
import { decodeMessages, encodeMessages } from "../lib/messages-codec.js";
import { resolveModel, type ProviderOptions } from "../llm/resolve.js";
import { extractUsage, recordEachCall } from "../llm/usage.js";
import { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import type { Context } from "../trpc/context.js";
import type { ChatToolWriter as StreamWriter } from "@tracer-sh/shared";
import { getCurrentDateBlock, getCurrentTimeText } from "../lib/current-context.js";
import { stampSentTime, withPromptCaching, withSentTimes } from "../llm/prompt-cache.js";
import { EVIDENCE_GROUNDING, PLAIN_LANGUAGE } from "../lib/shared-prompts.js";
import { CONFIG } from "../config.js";
import { isTransientError } from "../lib/transient.js";
import { createToolGate } from "../tools/tool-gate.js";
import { ANALYSIS_TOOL_NAME, createBeginAnalysisTool } from "../tools/analysis-tool.js";
import { reviewConclusion } from "./utility/review.js";

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
  collectTools: (writer: StreamWriter) => Promise<{
    tools: Record<string, unknown> | undefined;
    systemPrompt?: string;
    promptFragments?: string[];
    maxSteps?: number;
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
}

/**
 * Idempotent session cleanup: mark done in DB, signal broadcaster, remove from active map.
 * DB update runs first so clients refetching after broadcaster.finish() see status="done".
 */
async function finalizeSession(sessionId: string, context: Context, broadcaster: StreamBroadcaster): Promise<void> {
  if (!context.activeStreams.has(sessionId)) return;
  try {
    await context.db
      .update(chatSessions)
      .set({ status: "done", updatedAt: unixNow() })
      .where(eq(chatSessions.id, sessionId))
      .run();
  } catch (err) {
    console.warn(`[chat] Failed to mark ${sessionId} done:`, err);
  } finally {
    sessionChanged(sessionId);
    broadcaster.finish();
    context.activeStreams.delete(sessionId);
  }
}

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

/**
 * Background LLM processing — runs completely independent of the HTTP response.
 * Emits stream parts to the broadcaster; saves messages to DB after each tool step and on completion.
 * Returns the error of a failed attempt and the messages of its last saved step, which a re-run continues from.
 * A failed last attempt and a stopped run still save the reply they produced.
 */
async function processLLMStream(
  sessionId: string,
  messages: UIMessage[],
  context: Context,
  broadcaster: StreamBroadcaster,
  serverAbort: AbortController,
  collectTools: ChatAgentConfig["collectTools"],
  sessionTitle: ChatAgentConfig["sessionTitle"],
  model: Parameters<typeof streamText>[0]["model"],
  provider: string,
  modelId: string,
  providerOptions: ProviderOptions,
  compaction: { summary?: string | null; summaryUpTo?: number | null },
  final: boolean,
): Promise<{ error?: string; transient?: boolean; checkpoint?: UIMessage[] }> {
  // Sub-agent progress per tool call, so a stopped run keeps what its tools streamed.
  const progress = new Map<string, ProgressPart[]>();
  const writer: StreamWriter = {
    write: (part) => {
      const p = part as Record<string, unknown>;
      if (p.type === "data-provider-part") {
        const data = p.data as { toolCallId: string; part: { type: string } };
        progress.set(data.toolCallId, mergeProgressPart(progress.get(data.toolCallId) ?? [], data.part));
      }
      const emitted = p.type === "data-provider-part"
        ? { ...p, transient: true }
        : p;
      broadcaster.emit(emitted);
    },
    sessionId,
  };
  const collected = await collectTools(writer);
  // One gate per attempt: it holds the tool calls of a step to the read limit and runs writes alone.
  // The run's own model reviews the conclusion; swap the tool before gating so it stays a gated write.
  const tools = collected.tools && createToolGate()(
    ANALYSIS_TOOL_NAME in collected.tools
      ? { ...collected.tools, [ANALYSIS_TOOL_NAME]: createBeginAnalysisTool((ledger, msgs, signal) => reviewConclusion(context.db, sessionId, model, modelId, ledger, msgs, signal)) }
      : collected.tools,
  );

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
    const basePrompt = `You are Tracer — an AI debugging assistant for engineers investigating incidents across their observability stack. Be direct, follow evidence, and surface uncertainty rather than guessing. Skip preamble and caveats; get to the answer.

If a tool call fails, retry with a corrected approach. If you fail the same tool call twice, DO NOT retry again — stop and explain the issue to the user. Ask clarifying questions if needed. Never silently give up.

When the user's question spans multiple providers, query each relevant provider and synthesize findings across the results.`;
    const fragments = collected.promptFragments ?? [];
    systemPrompt = fragments.length > 0
      ? `${basePrompt}\n\n${EVIDENCE_GROUNDING}\n\n${PLAIN_LANGUAGE}\n\n${fragments.join("\n\n")}`
      : `${basePrompt}\n\n${PLAIN_LANGUAGE}\n\nNo observability providers are currently configured. If the user asks about observability data, let them know they can connect providers in the Settings page.`;
  }

  systemPrompt += "\n\n" + await getCurrentDateBlock(context.db);

  if (modelInput.some((m) => m.parts.some((p) => p.type === "file"))) {
    systemPrompt += "\n\n" + IMAGE_ANALYSIS_GUIDANCE;
  }

  if (summaryForPrompt) {
    systemPrompt += `\n\n## Earlier conversation summary\nThe earlier part of this conversation was compacted to save context. The summary below replaces those messages: the work it describes is already done — do NOT redo it. Reuse its recorded results, identifiers and queries as facts. Its conclusions are earlier claims: keep them while the data agrees, and test them again when a new result contradicts them.\n\n<conversation_summary>\n${summaryForPrompt}\n</conversation_summary>`;
  }

  const cached = withPromptCaching(provider, systemPrompt, providerOptions);
  const result = streamText({
    model,
    temperature: 0,
    instructions: cached.instructions,
    messages: modelMessages,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    stopWhen: tools ? isStepCount(collected.maxSteps ?? 15) : undefined,
    providerOptions: cached.providerOptions,
    abortSignal: serverAbort.signal,
    onLanguageModelCallEnd: recordEachCall(context.db, sessionId, "chat", modelId),
  });

  // Promise that resolves when the detached persistence IIFE in onEnd completes.
  // Gates the fallback cleanup so processLLMStream doesn't return prematurely.
  let resolveFinish!: () => void;
  const finishPromise = new Promise<void>((r) => { resolveFinish = r; });
  let failure: unknown;
  let streamError: unknown;
  let errorSent = false;
  let checkpoint: UIMessage[] | undefined;
  let stepSaved = false;
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
      const failed = outcome.status === "failed" || finishReason === "error";
      if (failed) {
        failure = (outcome.status === "failed" ? outcome.error : undefined) ?? streamError ?? new Error("The model stream failed");
        // A re-run continues from the last saved step, so an attempt that will be re-run saves no more.
        if (!final && isTransientError(failure)) {
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
              toSave = messages;
            } else {
              const metadata = { ...(reply.metadata as object | undefined), error: failureNote(failure) };
              toSave = [...updatedMessages.slice(0, -1), { ...reply, metadata }];
            }
          }
          if (toSave === messages) return;

          // A stopped or failed reply can end inside a tool call; saved, it would show as still running.
          const withProgress = toSave.map((msg) => msg.role !== "assistant" ? msg : {
            ...msg,
            parts: msg.parts.map((part) => {
              const p = part as Record<string, unknown>;
              const streamed = typeof p.toolCallId === "string" ? progress.get(p.toolCallId) : undefined;
              return streamed?.length && p.state !== "output-available" && p.state !== "output-error"
                ? { ...p, output: { parts: streamed } } as typeof part
                : part;
            }),
          });
          const enrichedMessages = sanitizeMessages(withProgress).map((msg, i) => {
            if (msg.role !== "assistant") return msg;
            const parts = msg.parts;
            if (i === toSave.length - 1) {
              return { ...msg, parts, usage: chatUsage };
            }
            return { ...msg, parts };
          });

          const title = sessionTitle(enrichedMessages);
          const now = unixNow();
          const packed = encodeMessages(enrichedMessages);

          await context.db
            .insert(chatSessions)
            .values({
              id: sessionId,
              title,
              messages: packed,
              status: "done",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: chatSessions.id,
              set: {
                title: sql`CASE WHEN ${chatSessions.title} = ${DEFAULT_SESSION_TITLE} THEN ${title} ELSE ${chatSessions.title} END`,
                messages: packed,
                status: sql`CASE WHEN ${chatSessions.status} = 'idle' THEN 'idle' ELSE 'done' END`,
                updatedAt: now,
              },
            })
            .run();
          sessionChanged(sessionId);

          // A stopped reply is partial; follow-up work (e.g. a monitor's report) waits for a full run.
          if (!failed && !serverAbort.signal.aborted && collected.afterComplete) {
            let lastUserText = "";
            let lastAssistantText = "";
            for (let i = enrichedMessages.length - 1; i >= 0; i--) {
              const msg = enrichedMessages[i];
              const text = msg.parts.find((p: { type: string }) => p.type === "text");
              if (msg.role === "assistant" && !lastAssistantText && text) {
                lastAssistantText = (text as { text: string }).text;
              } else if (msg.role === "user" && !lastUserText && text) {
                lastUserText = (text as { text: string }).text;
              }
              if (lastUserText && lastAssistantText) break;
            }
            collected.afterComplete({ lastUserMessage: lastUserText, lastAssistantText, sessionId });
          }
        } catch (err) {
          console.warn(`[chat] Failed to save session ${sessionId}:`, err);
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
            .set({ messages: encodeMessages(sanitizeMessages(stepMessages)), updatedAt: unixNow() })
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const v = value as Record<string, unknown>;
      if (v.type === "start-step") {
        reasoningChars = 0;
      } else if (v.type === "reasoning-delta" && typeof v.delta === "string") {
        reasoningChars += v.delta.length;
        if (reasoningChars > CONFIG.maxReasoningCharsPerStep) {
          console.warn(`[chat] reasoning exceeded ${CONFIG.maxReasoningCharsPerStep} chars in one step — aborting ${sessionId}`);
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
    console.warn(`[chat] Stream error for ${sessionId}:`, err);
    failure ??= err;
  } finally {
    reader.releaseLock();
    readDone();
  }

  // Wait for onEnd persistence to complete.
  // If the stream was aborted before onEnd could fire, use a timeout fallback.
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((r) => { timeoutId = setTimeout(r, 5000); });
  await Promise.race([finishPromise, timeout]);
  clearTimeout(timeoutId!);
  if (serverAbort.signal.aborted || failure === undefined) return {};
  const transient = isTransientError(failure);
  // A dropped connection throws instead of sending an error part; clients need one to show Retry.
  if ((final || !transient) && !errorSent) broadcaster.emit({ type: "error", errorText: "An error occurred." });
  return { error: errorText(failure), transient, checkpoint };
}

export async function runChatAgent({
  sessionId, messages: incoming, summary, summaryUpTo, context, collectTools, sessionTitle, retryDelaysMs = [], onFailed, scope, resumed,
}: ChatAgentConfig) {
  const messages = stampSentTime(incoming, await getCurrentTimeText(context.db));
  const resolved = await resolveModel(context.db);
  if ("error" in resolved) return { error: resolved.error };
  const { model, provider, modelId, providerOptions } = resolved;

  // Prevent concurrent streams on the same session
  if (context.activeStreams.has(sessionId)) {
    return { error: "Session is already processing a response" };
  }

  // Create server-owned abort controller + broadcaster
  const serverAbort = new AbortController();
  const broadcaster = new StreamBroadcaster();
  context.activeStreams.set(sessionId, { broadcaster, controller: serverAbort });

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
      })
      .onConflictDoUpdate({
        target: chatSessions.id,
        set: { messages: packed, status: "streaming", runScope: scope ?? null, resumed: resumed ? 1 : 0, updatedAt: now },
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
  (async () => {
    // Each re-run continues from the last saved step of the attempts before it.
    let history = messages;
    for (let attempt = 0; ; attempt++) {
      const final = attempt >= retryDelaysMs.length;
      // A throw before the model call (tool setup, history conversion) is a failed attempt too, so it is retried and reported.
      const { error, transient, checkpoint } = await processLLMStream(
        sessionId, history, context, broadcaster, serverAbort,
        collectTools, sessionTitle, model, provider, modelId, providerOptions,
        { summary, summaryUpTo }, final,
      ).catch((err: unknown): { error?: string; transient?: boolean; checkpoint?: UIMessage[] } => {
        if (serverAbort.signal.aborted) return {};
        const transient = isTransientError(err);
        // Clients need an error part to show Retry, as for a failure inside the stream.
        if (final || !transient) broadcaster.emit({ type: "error", errorText: "An error occurred." });
        return { error: errorText(err), transient };
      });
      if (error === undefined) break;
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
    console.error(`[chat] Unhandled error in LLM processing for ${sessionId}:`, err);
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

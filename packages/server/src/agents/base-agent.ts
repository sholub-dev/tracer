import { streamText, smoothStream, convertToModelMessages, stepCountIs, createUIMessageStream, type UIMessage, type ToolSet } from "ai";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_SESSION_TITLE, unixNow, type AfterCompleteParams } from "@tracer-sh/shared";
import { chatSessions } from "../db/schema.js";
import { resolveModel, type ProviderOptions, type ResolvedModel } from "../llm/resolve.js";
import { extractUsage, recordAgentRun } from "../llm/usage.js";
import { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import type { Context } from "../trpc/context.js";
import type { ChatToolWriter as StreamWriter } from "@tracer-sh/shared";
import { getCurrentDateBlock } from "../lib/current-context.js";

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
        if (p.toolCallId && p.state !== "output-available") {
          return { ...p, state: "output-available", output: p.output ?? { error: "Aborted" } };
        }
        return part;
      });
    return { ...msg, parts } as UIMessage;
  });
}

export function loadSessionMessages(db: Context["db"], sessionId: string, newMessage: UIMessage): UIMessage[] {
  const existing = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  let previous: UIMessage[] = [];
  if (existing) {
    try {
      previous = JSON.parse(existing.messages);
    } catch {
      console.warn(`[chat] Corrupted session ${sessionId}, starting fresh`);
    }
  }
  return [...sanitizeMessages(previous), newMessage];
}

export interface ChatAgentConfig {
  sessionId: string;
  messages: UIMessage[];
  context: Context;
  collectTools: (writer: StreamWriter) => {
    tools: Record<string, unknown> | undefined;
    systemPrompt?: string;
    promptFragments?: string[];
    maxSteps?: number;
    afterComplete?: (params: AfterCompleteParams) => void;
  };
  sessionTitle: (messages: UIMessage[]) => string;
  /** Override the default chat model (e.g. use sub-agent model in direct mode). */
  modelOverride?: ResolvedModel;
}

/**
 * Idempotent session cleanup: mark done in DB, signal broadcaster, remove from active map.
 * DB update runs first so clients refetching after broadcaster.finish() see status="done".
 */
function finalizeSession(sessionId: string, context: Context, broadcaster: StreamBroadcaster): void {
  if (!context.activeStreams.has(sessionId)) return;
  context.db
    .update(chatSessions)
    .set({ status: "done", updatedAt: unixNow() })
    .where(eq(chatSessions.id, sessionId))
    .run();
  broadcaster.finish();
  context.activeStreams.delete(sessionId);
}

/**
 * Background LLM processing — runs completely independent of the HTTP response.
 * Emits stream parts to the broadcaster; saves messages to DB on completion.
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
  modelId: string,
  providerOptions: ProviderOptions,
): Promise<void> {
  const writer: StreamWriter = {
    write: (part) => {
      const p = part as Record<string, unknown>;
      const emitted = p.type === "data-provider-part"
        ? { ...p, transient: true }
        : p;
      broadcaster.emit(emitted);
    },
    sessionId,
  };
  const collected = collectTools(writer);
  const tools = collected.tools;

  const modelMessages = await convertToModelMessages(messages, {
    tools: tools as ToolSet | undefined,
    convertDataPart: () => undefined,
  });

  let systemPrompt: string;
  if (collected.systemPrompt) {
    systemPrompt = collected.systemPrompt;
  } else {
    const basePrompt = `You are Tracer — an AI debugging assistant for engineers investigating incidents across their observability stack. Be direct, follow evidence, and surface uncertainty rather than guessing. Skip preamble and caveats; get to the answer.

If a tool call fails, retry with a corrected approach. If you fail the same tool call twice, DO NOT retry again — stop and explain the issue to the user. Ask clarifying questions if needed. Never silently give up.

When the user's question spans multiple providers, call the relevant provider tools IN PARALLEL in the same step. Each runs independently with its own sub-agent. After all complete, synthesize findings across providers.`;
    const fragments = collected.promptFragments ?? [];
    systemPrompt = fragments.length > 0
      ? `${basePrompt}\n\n${fragments.join("\n\n")}`
      : `${basePrompt}\n\nNo observability providers are currently configured. If the user asks about observability data, let them know they can connect providers in the Settings page.`;
  }

  systemPrompt += "\n\n" + getCurrentDateBlock(context.db);

  const result = streamText({
    model,
    temperature: 0,
    system: systemPrompt,
    messages: modelMessages,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    stopWhen: tools ? stepCountIs(collected.maxSteps ?? 15) : undefined,
    providerOptions,
    experimental_transform: smoothStream({ chunking: "word" }),
    abortSignal: serverAbort.signal,
  });

  // Promise that resolves when the detached persistence IIFE in onFinish completes.
  // Gates the fallback cleanup so processLLMStream doesn't return prematurely.
  let resolveFinish!: () => void;
  const finishPromise = new Promise<void>((r) => { resolveFinish = r; });

  const uiStream = result.toUIMessageStream({
    sendStart: false,
    originalMessages: messages,
    onFinish: ({ messages: updatedMessages }) => {
      finalizeSession(sessionId, context, broadcaster);

      // onFinish is synchronous but totalUsage requires an await, so full
      // persistence runs in a detached IIFE to avoid blocking the stream close.
      (async () => {
        try {
          const rawUsage = await result.totalUsage;
          const chatUsage = extractUsage(rawUsage, modelId);

          const enrichedMessages = updatedMessages.map((msg, i) => {
            if (msg.role !== "assistant") return msg;
            const parts = msg.parts;
            if (i === updatedMessages.length - 1) {
              return { ...msg, parts, usage: chatUsage };
            }
            return { ...msg, parts };
          });

          const title = sessionTitle(enrichedMessages);
          const now = unixNow();

          recordAgentRun(context.db, {
            sessionId,
            agentType: "chat",
            model: modelId,
            usage: chatUsage,
          });

          context.db
            .insert(chatSessions)
            .values({
              id: sessionId,
              title,
              messages: JSON.stringify(enrichedMessages),
              status: "done",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: chatSessions.id,
              set: {
                title: sql`CASE WHEN ${chatSessions.title} = ${DEFAULT_SESSION_TITLE} THEN ${title} ELSE ${chatSessions.title} END`,
                messages: JSON.stringify(enrichedMessages),
                status: sql`CASE WHEN ${chatSessions.status} = 'idle' THEN 'idle' ELSE 'done' END`,
                updatedAt: now,
              },
            })
            .run();

          if (collected.afterComplete) {
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

  // This loop runs independently of any HTTP connection.
  const reader = uiStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Strip providerMetadata — the AI SDK emits it on some event types
      // but its own strictObject schema rejects it on the client side.
      const { providerMetadata: _, ...clean } = value as Record<string, unknown>;
      broadcaster.emit(clean);
    }
  } catch (err) {
    console.warn(`[chat] Stream error for ${sessionId}:`, err);
  } finally {
    reader.releaseLock();
  }

  // Wait for onFinish persistence to complete.
  // If the stream was aborted before onFinish could fire, use a timeout fallback.
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((r) => { timeoutId = setTimeout(r, 5000); });
  await Promise.race([finishPromise, timeout]);
  clearTimeout(timeoutId!);

  // Fallback cleanup if onFinish never ran (e.g. abort before stream completes)
  finalizeSession(sessionId, context, broadcaster);
}

export async function runChatAgent({ sessionId, messages, context, collectTools, sessionTitle, modelOverride }: ChatAgentConfig) {
  const resolved = modelOverride ?? resolveModel(context.db);
  if ("error" in resolved) return { error: resolved.error };
  const { model, modelId, providerOptions } = resolved;

  // Prevent concurrent streams on the same session
  if (context.activeStreams.has(sessionId)) {
    return { error: "Session is already processing a response" };
  }

  // Create server-owned abort controller + broadcaster
  const serverAbort = new AbortController();
  const broadcaster = new StreamBroadcaster();
  context.activeStreams.set(sessionId, { broadcaster, controller: serverAbort });

  const now = unixNow();
  context.db
    .insert(chatSessions)
    .values({
      id: sessionId,
      title: DEFAULT_SESSION_TITLE,
      messages: JSON.stringify(messages),
      status: "streaming",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: chatSessions.id,
      set: { messages: JSON.stringify(messages), status: "streaming", updatedAt: now },
    })
    .run();

  // Start LLM processing in background — completely decoupled from HTTP lifecycle.
  // If the HTTP response is cancelled (client navigates away), this continues running.
  processLLMStream(
    sessionId, messages, context, broadcaster, serverAbort,
    collectTools, sessionTitle, model, modelId, providerOptions,
  ).catch((err) => {
    console.error(`[chat] Unhandled error in LLM processing for ${sessionId}:`, err);
    finalizeSession(sessionId, context, broadcaster);
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

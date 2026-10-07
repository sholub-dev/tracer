import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { ProgressStore } from "../../lib/progress-store";
import { handleProgressData, stopChat, useCompactedMessages } from "../../lib/chat-utils";
import { useChatScroll, useEscapeToStop } from "../../lib/hooks";
import { WEB_CONFIG } from "../../lib/config";
import { readEventStream } from "../../lib/sse";
import { serverFetch } from "../../lib/server-fetch";
import { useOnResume } from "../../lib/resume";
import { AlertSummaryPanel, alertSummaryOf } from "./AlertSummaryPanel";
import { WorkingIndicator } from "./ChatIndicators";
import { Composer } from "./Composer";
import { FollowUpTimerBar } from "./FollowUpTimerBar";
import { MessageView } from "./MessageView";
import { Transcript } from "./Transcript";

interface LiveStreamViewProps {
  sessionId: string;
  initialMessages: UIMessage[];
  onComplete: () => void;
  /** Sticky header (session header). */
  header?: ReactNode;
  /** Rendered above the messages (compaction summary). */
  beforeMessages?: ReactNode;
  /** Hide the first N messages, as in ChatCore. */
  collapseCount?: number;
  /** Render only the analysis section of this message, as in ChatCore. */
  analysisOnlyIndex?: number;
  sources?: ReactNode;
  cost?: ReactNode;
}

/** Reconnects to an in-progress server stream over SSE and rebuilds the growing reply from replayed and live chunks. */
export function LiveStreamView({ sessionId, initialMessages, onComplete, header, beforeMessages, collapseCount = 0, analysisOnlyIndex, sources, cost }: LiveStreamViewProps) {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const progressStore = useRef(new ProgressStore()).current;
  const initialMessagesRef = useRef(initialMessages);
  initialMessagesRef.current = initialMessages;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useChatScroll();

  const wakeRef = useRef<() => void>(() => {});
  useOnResume(() => wakeRef.current());

  useEffect(() => {
    let cancelled = false;
    let conn: AbortController | null = null;
    let wakeDelay: (() => void) | null = null;
    let woken = false;
    wakeRef.current = () => { woken = true; conn?.abort(); wakeDelay?.(); };

    // Each connection replays the whole buffer, so it builds its own message and replaces the previous one.
    const readConnection = (stream: ReadableStream<UIMessageChunk>, isCurrent: () => boolean) => (async () => {
      // One render per chatThrottleMs: the server replays the whole buffered stream on subscribe.
      let latest: UIMessage | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        const msg = latest;
        latest = null;
        if (!cancelled && isCurrent() && msg) {
          // The server saves each tool step, so the loaded messages can end with the reply this stream rebuilds.
          const loaded = initialMessagesRef.current;
          setMessages([...(loaded.at(-1)?.role === "assistant" ? loaded.slice(0, -1) : loaded), msg]);
        }
      };
      try {
        for await (const msg of readUIMessageStream({ stream })) {
          if (cancelled || !isCurrent()) break;
          latest = msg;
          if (flushTimer === null) flushTimer = setTimeout(flush, WEB_CONFIG.chatThrottleMs);
        }
      } catch { /* stream ended */ }
      if (flushTimer !== null) clearTimeout(flushTimer);
      flush();
    })();

    (async () => {
      let current = 0;
      while (!cancelled) {
        const id = ++current;
        const controller = new AbortController();
        conn = controller;
        let ctrl!: ReadableStreamDefaultController<UIMessageChunk>;
        const chunkStream = new ReadableStream<UIMessageChunk>({ start(c) { ctrl = c; } });
        const reading = readConnection(chunkStream, () => id === current);
        progressStore.clear();
        let finished = false;
        let ended = false;
        try {
          const res = await serverFetch(`/api/chat/subscribe/${sessionId}`, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal: controller.signal });
          // Only a 404 means the server has no run; any other failure is retried.
          if (res.status === 404) {
            ended = true;
          } else if (res.ok && res.body && res.headers.get("content-type")?.startsWith("text/event-stream")) {
            await readEventStream(res.body, (event, data) => {
              if (event === "part") {
                try {
                  const part = JSON.parse(data);
                  if (part.type === "data-provider-part") handleProgressData(progressStore, part.data);
                  ctrl.enqueue(part as UIMessageChunk);
                } catch { /* ignore parse errors */ }
              } else if (event === "done") {
                finished = true;
                controller.abort();
              }
            }, controller.signal);
          } else {
            void res.body?.cancel().catch(() => {});
          }
        } catch { /* network error or abort */ }
        try { ctrl.close(); } catch { /* already closed */ }
        if (cancelled) return;
        if (finished || ended) {
          // onComplete fires after the last flush so the final content renders first.
          await reading;
          if (!cancelled) onCompleteRef.current();
          // With no run the session is not streaming and the parent unmounts this view; if it still reads streaming,
          // a restart is about to resume the run, so subscribe again.
          if (finished) return;
        }
        if (!woken) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, WEB_CONFIG.sseReconnectMs);
            wakeDelay = () => { clearTimeout(t); resolve(); };
          });
          wakeDelay = null;
        }
        woken = false;
      }
    })();

    return () => {
      cancelled = true;
      conn?.abort();
      wakeDelay?.();
      progressStore.clear();
    };
  }, [sessionId, progressStore]); // eslint-disable-line react-hooks/exhaustive-deps

  useEscapeToStop(true, () => void stopChat(sessionId));

  const alert = useMemo(() => alertSummaryOf(messages), [messages]);
  const lastIdx = messages.length - 1;
  const waiting = messages[lastIdx]?.role === "user";
  const { collapse, analysisOnlyMsg } = useCompactedMessages(messages, collapseCount, analysisOnlyIndex);

  return (
    <div className="flex h-full flex-col">
      <Transcript
        scrollRef={scrollRef}
        contentRef={contentRef}
        isAtBottom={isAtBottom}
        scrollToBottom={scrollToBottom}
        header={header}
        dock={
          <>
            <FollowUpTimerBar sessionId={sessionId} />
            <Composer
              value=""
              onChange={() => {}}
              onSubmit={() => {}}
              placeholder="Ask a follow-up"
              canSend={false}
              disabled
              streaming
              onStop={() => void stopChat(sessionId)}
              sources={sources}
              cost={cost}
            />
          </>
        }
      >
        {alert && <AlertSummaryPanel summary={alert.summary} triage={alert.triage} />}
        {beforeMessages}
        {messages.map((message, index) => index < collapse ? null : (
          <MessageView
            key={message.id || `msg-${index}`}
            msg={index === analysisOnlyIndex && analysisOnlyMsg ? analysisOnlyMsg : message}
            isAnimating={message.role === "assistant" && index === lastIdx}
            progressStore={progressStore}
            showActions={false}
          />
        ))}
        {waiting && <WorkingIndicator label="Investigating" />}
      </Transcript>
    </div>
  );
}

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { ProgressStore } from "../../lib/progress-store";
import { handleProgressData, stopChat, useCompactedMessages } from "../../lib/chat-utils";
import { useChatScroll, useEscapeToStop } from "../../lib/hooks";
import { WEB_CONFIG } from "../../lib/config";
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

  useEffect(() => {
    let cancelled = false;
    const eventSource = new EventSource(`/api/chat/subscribe/${sessionId}`);

    // Bridge SSE events into a ReadableStream for readUIMessageStream.
    let ctrl: ReadableStreamDefaultController<UIMessageChunk>;
    const chunkStream = new ReadableStream<UIMessageChunk>({
      start(c) { ctrl = c; },
    });

    let errorCount = 0;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;

    eventSource.addEventListener("part", (e) => {
      if (cancelled) return;
      errorCount = 0;
      try {
        const part = JSON.parse(e.data);
        if (part.type === "data-provider-part") handleProgressData(progressStore, part.data);
        ctrl.enqueue(part as UIMessageChunk);
      } catch { /* ignore parse errors */ }
    });

    // Only close here; onComplete fires after the last flush so the final content renders first.
    eventSource.addEventListener("done", () => {
      try { ctrl.close(); } catch { /* already closed */ }
      eventSource.close();
    });

    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        try { ctrl.close(); } catch { /* already closed */ }
        return;
      }
      // Transient error: allow auto-reconnect, but give up after a few within 10s.
      errorCount++;
      if (errorCount >= WEB_CONFIG.maxSseErrors) {
        try { ctrl.close(); } catch { /* already closed */ }
        eventSource.close();
        return;
      }
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { errorCount = 0; }, 10_000);
    };

    (async () => {
      // One render per chatThrottleMs: the server replays the whole buffered stream on subscribe.
      let latest: UIMessage | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        const msg = latest;
        latest = null;
        if (!cancelled && msg) setMessages([...initialMessagesRef.current, msg]);
      };
      try {
        for await (const msg of readUIMessageStream({ stream: chunkStream })) {
          if (cancelled) break;
          latest = msg;
          if (flushTimer === null) flushTimer = setTimeout(flush, WEB_CONFIG.chatThrottleMs);
        }
      } catch { /* stream ended */ }
      if (flushTimer !== null) clearTimeout(flushTimer);
      flush();
      if (!cancelled) onCompleteRef.current();
    })();

    return () => {
      cancelled = true;
      eventSource.close();
      if (errorTimer) clearTimeout(errorTimer);
      try { ctrl.close(); } catch { /* ignore */ }
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

import { useState, useEffect, useRef } from "react";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { theme } from "../../lib/theme";
import { ProgressStore } from "../../lib/progress-store";
import { MessageParts, ThinkingDots, ScrollToBottomButton } from "./MessageParts";
import { handleProgressData, normalizeClipboard } from "../../lib/chat-utils";
import { useChatScroll } from "../../lib/hooks";

interface LiveStreamViewProps {
  sessionId: string;
  initialMessages: UIMessage[];
  onComplete: () => void;
  /** Rendered in the sticky header area (e.g. SessionTitle) */
  header?: React.ReactNode;
  /** Rendered above the input area (e.g. ProviderToggle) */
  beforeInput?: React.ReactNode;
}

/**
 * Reconnects to an in-progress server stream via SSE.
 * Uses readUIMessageStream to reconstruct the growing assistant message
 * from replayed + live UIMessageChunk events.
 */
export function LiveStreamView({ sessionId, initialMessages, onComplete, header, beforeInput }: LiveStreamViewProps) {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const progressStore = useRef(new ProgressStore()).current;
  const initialMessagesRef = useRef(initialMessages);
  initialMessagesRef.current = initialMessages;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const { scrollRef, contentRef, isAtBottom, handleWheel, scrollToBottom } = useChatScroll();

  useEffect(() => {
    let cancelled = false;
    const eventSource = new EventSource(`/api/chat/subscribe/${sessionId}`);

    // Bridge SSE events into a ReadableStream for readUIMessageStream
    let ctrl: ReadableStreamDefaultController<UIMessageChunk>;
    const chunkStream = new ReadableStream<UIMessageChunk>({
      start(c) { ctrl = c; },
    });

    let errorCount = 0;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;

    eventSource.addEventListener("part", (e) => {
      if (cancelled) return;
      errorCount = 0; // reset on successful event
      try {
        const part = JSON.parse(e.data);
        if (part.type === "data-provider-part") {
          handleProgressData(progressStore, part.data);
        }
        ctrl.enqueue(part as UIMessageChunk);
      } catch { /* ignore parse errors */ }
    });

    eventSource.addEventListener("done", () => {
      try { ctrl.close(); } catch { /* already closed */ }
      eventSource.close();
      if (!cancelled) onCompleteRef.current();
    });

    eventSource.onerror = () => {
      // EventSource.CLOSED = permanent failure, close immediately
      if (eventSource.readyState === EventSource.CLOSED) {
        try { ctrl.close(); } catch { /* already closed */ }
        if (!cancelled) onCompleteRef.current();
        return;
      }
      // Transient error — allow auto-reconnect, but give up after 3 within 10s
      errorCount++;
      if (errorCount >= 3) {
        try { ctrl.close(); } catch { /* already closed */ }
        eventSource.close();
        if (!cancelled) onCompleteRef.current();
        return;
      }
      if (errorTimer) clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { errorCount = 0; }, 10_000);
    };

    (async () => {
      try {
        for await (const msg of readUIMessageStream({ stream: chunkStream })) {
          if (cancelled) break;
          setMessages([...initialMessagesRef.current, msg]);
        }
      } catch { /* stream ended */ }
    })();

    return () => {
      cancelled = true;
      eventSource.close();
      if (errorTimer) clearTimeout(errorTimer);
      try { ctrl.close(); } catch { /* ignore */ }
      progressStore.clear();
    };
  }, [sessionId, progressStore]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = async () => {
    try {
      await fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch { /* ignore */ }
  };

  const showThinking =
    messages.length > 0 && messages[messages.length - 1]?.role === "user";

  const lastIdx = messages.length - 1;

  return (
    <div className={theme.chatContainer}>
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="overflow-y-auto overflow-x-hidden h-full"
          onWheel={handleWheel}
          onCopy={normalizeClipboard}
        >
          <div ref={contentRef}>
            {header}

            {messages.map((message, index) => {
              const isAnimating = message.role === "assistant" && index === lastIdx;
              return (
                <div key={message.id || `msg-${index}`} className="px-10">
                  {index > 0 && <div className={theme.chatSeparator} />}
                  <div>
                    <div className={message.role === "user" ? theme.chatUserLabel : theme.chatAssistantLabel}>
                      {message.role === "user" ? "you" : "assistant"}
                    </div>
                    <div className={message.role === "user" ? theme.chatUserMessage : theme.chatAssistantMessage}>
                      <MessageParts
                        parts={message.parts}
                        isAnimating={isAnimating}
                        progressStore={progressStore}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {showThinking && (
              <div className="px-10">
                <div className={theme.chatSeparator} />
                <ThinkingDots className={theme.chatThinking} />
              </div>
            )}

            <div style={{ height: "40px" }} />
          </div>
        </div>
        <ScrollToBottomButton isAtBottom={isAtBottom} scrollToBottom={scrollToBottom} />
      </div>

      {beforeInput}
      <div className={theme.chatInputArea}>
        <div className="flex gap-3 items-start">
          <textarea
            placeholder="Ask a debugging question..."
            disabled
            rows={1}
            className={theme.chatInput}
          />
          <button
            type="button"
            onClick={handleStop}
            aria-label="Stop generating"
            className={theme.chatStopButton}
          >
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

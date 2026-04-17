import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useImperativeHandle,
  forwardRef,
  createRef,
  type ReactNode,
} from "react";
import { useChat, Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { theme } from "../../lib/theme";
import { ProgressStore } from "../../lib/progress-store";
import { useChatScroll } from "../../lib/hooks";
import { MessageParts, ThinkingDots, ScrollToBottomButton } from "./MessageParts";
import { handleProgressData, normalizeClipboard } from "../../lib/chat-utils";
import { CopyMessageButton } from "./CopyMessageButton";
import { WEB_CONFIG } from "../../lib/config";

// ── Variant theme maps ──

const VARIANT_CLASSES = {
  full: {
    userMessage: theme.chatUserMessage,
    assistantMessage: theme.chatAssistantMessage,
    separator: theme.chatSeparator,
    thinking: theme.chatThinking,
    emptyState: theme.chatEmptyState,
    inputArea: theme.chatInputArea,
    textarea: theme.chatInput,
    sendBtn: theme.chatButton,
    stopBtn: theme.chatStopButton,
    continueMargin: "mt-4",
  },
  panel: {
    userMessage: theme.panelChatUserMessage,
    assistantMessage: theme.panelChatAssistantMessage,
    separator: theme.panelChatSeparator,
    thinking: theme.panelChatThinking,
    emptyState: theme.panelChatEmptyState,
    inputArea: theme.panelChatInputArea,
    textarea: theme.panelChatTextarea,
    sendBtn: theme.primaryBtn,
    stopBtn: theme.secondaryBtn,
    continueMargin: "mt-3",
  },
} as const;

// ── Types ──

export interface ChatCoreProps {
  chatId: string;
  apiEndpoint: string;
  placeholder?: string;
  extraBody?: Record<string, unknown>;
  onData?: (part: { type: string; data: unknown }) => void;
  initialMessages?: UIMessage[];
  onStatusChange?: (status: string, messages: UIMessage[]) => void;
  onBeforeStop?: (ctx: {
    messages: UIMessage[];
    progressStore: ProgressStore;
  }) => void;
  variant?: "full" | "panel";

  // Render slots
  header?: ReactNode;
  /** Rendered inside the scroll container (e.g. sticky headers) */
  scrollHeader?: ReactNode;
  /** Rendered below the placeholder in the empty state */
  emptyStateExtras?: ReactNode;
  beforeInput?: ReactNode;
  afterMessages?: ReactNode;
  renderMessage?: (
    msg: UIMessage,
    index: number,
    defaults: { label: ReactNode; content: ReactNode },
  ) => ReactNode;

  /** When true, hide the composer, Continue button, and error-banner Retry. */
  readOnly?: boolean;

  /** Threaded into MessageParts so the "Download as image" action can embed them. */
  sourceTitle?: string;
  sourceCreatedAt?: number;
  /** Called at download time to fetch the freshest title (async-generated titles
   *  race with a user clicking "Download as image" right after the stream ends). */
  resolveSourceTitle?: () => Promise<string | undefined>;

  className?: string;
}

export interface ChatCoreRef {
  messages: UIMessage[];
  setMessages: (msgs: UIMessage[]) => void;
  sendMessage: (msg: { text: string }) => void;
  stop: () => void;
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void;
  scrollToTop: (opts?: { animation?: "instant" | "smooth" }) => void;
  progressStore: ProgressStore;
  status: string;
  isLoading: boolean;
  error?: Error | undefined;
}

export const ChatCore = forwardRef<ChatCoreRef, ChatCoreProps>(
  function ChatCore(
    {
      chatId,
      apiEndpoint,
      placeholder = "Send a message...",
      extraBody,
      onData,
      initialMessages,
      onStatusChange,
      onBeforeStop,
      variant = "full",
      header,
      scrollHeader,
      emptyStateExtras,
      beforeInput,
      afterMessages,
      renderMessage,
      readOnly = false,
      sourceTitle,
      sourceCreatedAt,
      resolveSourceTitle,
      className,
    },
    ref,
  ) {
    const [input, setInput] = useState("");
    const progressStore = useRef(new ProgressStore()).current;
    const v = VARIANT_CLASSES[variant];
    const pad = variant === "panel" ? "px-4" : "px-10";
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const { scrollRef, contentRef, isAtBottom, handleWheel, scrollToBottom, scrollToTop } = useChatScroll();

    // Stable refs for callbacks used inside Chat constructor
    const onDataRef = useRef(onData);
    onDataRef.current = onData;
    const extraBodyRef = useRef(extraBody);
    extraBodyRef.current = extraBody;

    // Chat instance — stable per mount (component is keyed externally)
    const chat = useMemo(
      () =>
        new Chat({
          id: chatId,
          messages: initialMessages,
          transport: new DefaultChatTransport({
            api: apiEndpoint,
            prepareSendMessagesRequest: ({ id, messages }) => ({
              body: {
                id,
                message: messages[messages.length - 1],
                ...extraBodyRef.current,
              },
            }),
          }),
          onData: (part) => {
            if (part.type === "data-provider-part") {
              handleProgressData(
                progressStore,
                part.data as {
                  toolCallId: string;
                  part: { type: string; [key: string]: unknown };
                },
              );
            }
            onDataRef.current?.(part as { type: string; data: unknown });
          },
        }),
      [], // eslint-disable-line react-hooks/exhaustive-deps
    );

    const { messages, setMessages, status, sendMessage, stop, error } = useChat({
      chat,
      experimental_throttle: WEB_CONFIG.chatThrottleMs,
    });
    const sendMessageRef = useRef(sendMessage);
    sendMessageRef.current = sendMessage;
    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    const isLoading = status === "submitted" || status === "streaming";

    // Track status transitions
    const prevStatus = useRef(status);
    const onStatusChangeRef = useRef(onStatusChange);
    onStatusChangeRef.current = onStatusChange;
    useEffect(() => {
      if (prevStatus.current !== status) {
        if (status === "ready") {
          progressStore.clear();
          textareaRef.current?.focus();
        }
        onStatusChangeRef.current?.(status, messages);
      }
      prevStatus.current = status;
    }, [status, messages]); // eslint-disable-line react-hooks/exhaustive-deps

    // Continue / retry detection
    const lastMessage = messages[messages.length - 1];
    const lastPart = lastMessage?.parts[lastMessage.parts.length - 1];
    const needsContinue =
      !isLoading &&
      messages.length > 0 &&
      lastMessage?.role === "assistant" &&
      lastPart?.type.startsWith("tool-");

    const lastPartState = (lastPart as { state?: string } | undefined)?.state;
    const isSubAgentRunning =
      lastPart?.type.startsWith("tool-") && lastPartState !== "output-available";
    const isContentStreaming = lastPart?.type === "text" || lastPart?.type === "reasoning";
    const showThinkingDots =
      status === "submitted" ||
      (status === "streaming" && !isContentStreaming && !isSubAgentRunning);

    const lastId = status === "streaming" ? messages[messages.length - 1]?.id : null;

    const handleStop = () => {
      onBeforeStop?.({ messages, progressStore });
      fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: chatId }),
      }).catch(() => {});
      stop();
    };

    // Stable ref so Escape effect doesn't need handleStop in deps
    const handleStopRef = useRef(handleStop);
    handleStopRef.current = handleStop;

    // Escape to stop generation
    useEffect(() => {
      if (!isLoading) return;
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") handleStopRef.current();
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [isLoading]);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || isLoading) return;
      setInput("");
      scrollToBottom({ animation: "instant" });
      sendMessage({ text });
      textareaRef.current?.focus();
    };

    const handleContinue = useCallback(() => {
      scrollToBottom({ animation: "instant" });
      sendMessageRef.current({ text: "Continue" });
    }, [scrollToBottom]);

    // Retry last user message (used for error recovery)
    const handleRetry = useCallback(() => {
      const msgs = messagesRef.current;
      let userIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "user") { userIdx = i; break; }
      }
      if (userIdx === -1) return;
      const msg = msgs[userIdx];
      const textPart = msg.parts.find((p) => p.type === "text");
      if (!textPart || textPart.type !== "text") return;
      setMessages(msgs.slice(0, userIdx));
      sendMessageRef.current({ text: textPart.text });
    }, [setMessages]);

    // Expose imperative API
    useImperativeHandle(
      ref,
      () => ({
        messages,
        setMessages,
        sendMessage,
        stop,
        scrollToBottom,
        scrollToTop,
        progressStore,
        status,
        isLoading,
        error,
      }),
      [messages, setMessages, sendMessage, stop, scrollToBottom, scrollToTop, progressStore, status, isLoading, error],
    );

    return (
      <div className={`flex flex-col h-full ${className ?? ""}`}>
        {header}

        <div className="relative flex-1 min-h-0">
          <div
            ref={scrollRef}
            className={`overflow-y-auto overflow-x-hidden h-full${variant === "panel" ? " py-4" : ""}`}
            onWheel={handleWheel}
            onCopy={normalizeClipboard}
          >
            <div ref={contentRef} className="min-h-full flex flex-col">
              {scrollHeader}

              {messages.length === 0 && status !== "submitted" && (
                <div className="flex-1 flex flex-col items-center justify-center gap-6 py-16">
                  {emptyStateExtras ?? <span className={v.emptyState}>{placeholder}</span>}
                </div>
              )}

              {messages.map((msg, msgIndex) => {
                const isAnimating = msg.id === lastId;
                const messageRef = createRef<HTMLDivElement>();
                const label = (
                  <div className={msg.role === "user" ? theme.chatUserLabel : theme.chatAssistantLabel}>
                    {msg.role === "user" ? "you" : "assistant"}
                  </div>
                );
                const content = (
                  <div className={msg.role === "user" ? v.userMessage : v.assistantMessage}>
                    <MessageParts
                      parts={msg.parts}
                      isAnimating={isAnimating}
                      progressStore={progressStore}
                      sourceTitle={sourceTitle}
                      sourceCreatedAt={sourceCreatedAt}
                      resolveSourceTitle={resolveSourceTitle}
                    />
                  </div>
                );
                const defaultRendering = (
                  <div className="relative group">
                    {!isAnimating && (
                      <div className={theme.chatMessageActions}>
                        <CopyMessageButton contentRef={messageRef} parts={msg.parts} />
                      </div>
                    )}
                    <div ref={messageRef} className={theme.chatMessageCard}>
                      {label}
                      {content}
                    </div>
                  </div>
                );
                return (
                  <div key={msg.id || `msg-${msgIndex}`} className={pad}>
                    {msgIndex > 0 && <div className={v.separator} />}
                    {renderMessage
                      ? renderMessage(msg, msgIndex, { label, content })
                      : defaultRendering}
                  </div>
                );
              })}

              {showThinkingDots && (
                <div className={pad}>
                  {messages.length > 0 && <div className={v.separator} />}
                  <ThinkingDots className={v.thinking} />
                </div>
              )}

              {!readOnly && needsContinue && (
                <div className={`flex flex-col items-center gap-2 ${v.continueMargin} ${pad}`}>
                  <span className="text-xs text-[#9c9890] font-sans">Response was interrupted</span>
                  <button
                    type="button"
                    onClick={handleContinue}
                    className={theme.chatContinueButton}
                  >
                    Continue
                  </button>
                </div>
              )}

              {afterMessages && <div className={pad}>{afterMessages}</div>}

              {!readOnly && error && (
                <div className={pad}>
                  <div className="mt-3 text-sm text-[#b33a2a] bg-[#b33a2a]/5 border border-[#b33a2a]/20 rounded px-4 py-3 flex items-center gap-3">
                    <span className="flex-1">{error.message}</span>
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="text-xs underline shrink-0 font-sans"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              <div style={{ height: "40px" }} />
            </div>
          </div>
          <ScrollToBottomButton isAtBottom={isAtBottom} scrollToBottom={scrollToBottom} />
        </div>

        {beforeInput}
        {!readOnly && (
        <form onSubmit={handleSubmit} className={v.inputArea}>
          <div className={variant === "full" ? "flex gap-3 items-start" : "flex gap-2"}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                  const ta = e.target as HTMLTextAreaElement;
                  ta.style.height = "auto";
                }
              }}
              placeholder={placeholder}
              rows={1}
              autoFocus
              className={v.textarea}
            />
            {isLoading ? (
              <button type="button" onClick={handleStop} aria-label="Stop generating" className={v.stopBtn}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label="Send message"
                className={v.sendBtn}
              >
                Send
              </button>
            )}
          </div>
        </form>
        )}
      </div>
    );
  },
);

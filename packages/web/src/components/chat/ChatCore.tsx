import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useImperativeHandle,
  forwardRef,
  memo,
  type ReactNode,
} from "react";
import { useChat, Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { analysisSectionParts } from "@tracer-sh/shared";
import { theme } from "../../lib/theme";
import { ProgressStore } from "../../lib/progress-store";
import { useChatScroll, useFileDrop } from "../../lib/hooks";
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

const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const ATTACH_ACCEPT = "image/*,text/*,.md,.json,.csv,.log,application/pdf";

type Attachment = { file: File; url: string | null };

// Empty type allowed — many text files report no MIME type.
const isAttachable = (type: string) =>
  type === "" ||
  type.startsWith("image/") ||
  type.startsWith("text/") ||
  type === "application/pdf" ||
  type === "application/json";

function AttachFileIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

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
  /** Rendered inside the scroll container, above the message list (e.g. compaction summary). */
  beforeMessages?: ReactNode;
  /** Hide the first N messages (render-only — state and requests keep the full list). */
  collapseCount?: number;
  /** Show only the analysis section of the message at this index (render-only) —
   *  the kept boundary of an analysis compaction, whose working section (tool
   *  calls, intermediate text) is already covered by the summary above. */
  analysisOnlyIndex?: number;
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
  /** When true, keep the composer visible but block all sending (e.g. while compacting). */
  inputDisabled?: boolean;
  /** Called before the error-banner Retry re-sends, with the index the client
   *  list is cut to — lets the owner truncate the persisted copy in lockstep
   *  (the failed user message is usually already stored server-side). */
  onRetryTruncate?: (keepCount: number) => Promise<unknown>;

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

// Memoized so a streaming chunk only re-renders the row whose message object
// changed — the AI SDK keeps untouched messages referentially stable.
const MessageRow = memo(function MessageRow({
  msg,
  msgIndex,
  showSeparator,
  isAnimating,
  progressStore,
  variant,
  sourceTitle,
  sourceCreatedAt,
  resolveSourceTitle,
  renderMessage,
}: {
  msg: UIMessage;
  msgIndex: number;
  showSeparator: boolean;
  isAnimating: boolean;
  progressStore: ProgressStore;
  variant: "full" | "panel";
  sourceTitle?: string;
  sourceCreatedAt?: number;
  resolveSourceTitle?: () => Promise<string | undefined>;
  renderMessage?: ChatCoreProps["renderMessage"];
}) {
  const v = VARIANT_CLASSES[variant];
  const pad = variant === "panel" ? "px-4" : "px-10";
  const messageRef = useRef<HTMLDivElement>(null);
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
    <div className={pad}>
      {showSeparator && <div className={v.separator} />}
      {renderMessage ? renderMessage(msg, msgIndex, { label, content }) : defaultRendering}
    </div>
  );
});

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
      beforeMessages,
      collapseCount = 0,
      analysisOnlyIndex,
      emptyStateExtras,
      beforeInput,
      afterMessages,
      renderMessage,
      readOnly = false,
      inputDisabled = false,
      onRetryTruncate,
      sourceTitle,
      sourceCreatedAt,
      resolveSourceTitle,
      className,
    },
    ref,
  ) {
    const [input, setInput] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [attachError, setAttachError] = useState<string | null>(null);
    const progressStore = useRef(new ProgressStore()).current;
    const v = VARIANT_CLASSES[variant];
    const pad = variant === "panel" ? "px-4" : "px-10";
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const addFiles = useCallback((incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      const ok = list.filter((f) => isAttachable(f.type) && f.size <= MAX_ATTACH_BYTES);
      if (ok.length < list.length) {
        setAttachError("Some files were skipped — unsupported type or over 10 MB.");
        setTimeout(() => setAttachError(null), 3500);
      }
      if (ok.length) {
        setAttachments((prev) => [...prev, ...ok.map((f) => ({ file: f, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }))]);
      }
    }, []);

    const removeAttachment = useCallback((idx: number) => {
      setAttachments((prev) => {
        if (prev[idx]?.url) URL.revokeObjectURL(prev[idx].url!);
        return prev.filter((_, i) => i !== idx);
      });
    }, []);

    // Revoke any still-pending thumbnail URLs on unmount.
    const attachmentsRef = useRef(attachments);
    attachmentsRef.current = attachments;
    useEffect(() => () => { attachmentsRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url)); }, []);

    const { dragActive, dropProps } = useFileDrop(addFiles, !readOnly && !inputDisabled);

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

    // Render-only collapse; ignore a boundary that exceeds the actual list
    // (stale summary from a concurrent truncation) rather than hiding everything.
    const collapse = collapseCount <= messages.length ? collapseCount : 0;

    // Analysis-only view of a kept compaction boundary. Null when the message
    // at the index has no analysis section (normal boundary, stale index) —
    // the original then renders untouched. Keyed on the boundary message
    // itself (stable across streaming ticks), not the whole array, so the
    // boundary row's memo isn't broken on every streamed token.
    const boundaryMsg = analysisOnlyIndex !== undefined ? messages[analysisOnlyIndex] : undefined;
    const analysisOnlyMsg = useMemo(() => {
      if (!boundaryMsg || boundaryMsg.role !== "assistant") return null;
      const parts = analysisSectionParts(boundaryMsg.parts);
      return parts ? { ...boundaryMsg, parts } : null;
    }, [boundaryMsg]);

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

    // Continue / retry detection. `messages.length > collapse` keeps the banner
    // from rendering for an interrupted message that is collapsed out of view.
    const lastMessage = messages[messages.length - 1];
    const lastPart = lastMessage?.parts[lastMessage.parts.length - 1];
    const needsContinue =
      !isLoading &&
      messages.length > collapse &&
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

    // Restore composer focus when an input lock (e.g. compaction) releases —
    // disabling a focused textarea drops focus to <body>.
    const prevInputDisabled = useRef(inputDisabled);
    useEffect(() => {
      if (prevInputDisabled.current && !inputDisabled) textareaRef.current?.focus();
      prevInputDisabled.current = inputDisabled;
    }, [inputDisabled]);

    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if ((!text && attachments.length === 0) || isLoading || inputDisabled) return;
      setInput("");
      scrollToBottom({ animation: "instant" });
      if (attachments.length > 0) {
        // File-only turn keeps a default instruction so title generation, which
        // keys on a text part, still fires.
        const dt = new DataTransfer();
        attachments.forEach((a) => dt.items.add(a.file));
        sendMessage({ text: text || "Please analyze the attached file(s).", files: dt.files });
        attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
        setAttachments([]);
      } else {
        sendMessage({ text });
      }
      textareaRef.current?.focus();
    };

    const handleContinue = useCallback(() => {
      scrollToBottom({ animation: "instant" });
      sendMessageRef.current({ text: "Continue" });
    }, [scrollToBottom]);

    // Retry last user message (used for error recovery)
    const onRetryTruncateRef = useRef(onRetryTruncate);
    onRetryTruncateRef.current = onRetryTruncate;
    const handleRetry = useCallback(async () => {
      const msgs = messagesRef.current;
      let userIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "user") { userIdx = i; break; }
      }
      if (userIdx === -1) return;
      const msg = msgs[userIdx];
      const textPart = msg.parts.find((p) => p.type === "text");
      if (!textPart || textPart.type !== "text") return;
      // The failed user message may already be persisted server-side; trim the
      // server copy too, or the re-send appends a duplicate and shifts every
      // later message index (breaking edit/delete/compact boundaries).
      try {
        await onRetryTruncateRef.current?.(userIdx);
      } catch {
        return; // server truncate failed — leave state untouched, banner stays
      }
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
      <div className={`relative flex flex-col h-full ${className ?? ""}`} {...dropProps}>
        {dragActive && (
          <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center bg-[#2b5ea7]/10 border-2 border-dashed border-[#2b5ea7] rounded">
            <span className="text-sm font-medium text-[#2b5ea7] bg-white/90 px-4 py-2 rounded shadow-sm">Drop to attach</span>
          </div>
        )}
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

              {beforeMessages && <div className={pad}>{beforeMessages}</div>}

              {messages.length === 0 && status !== "submitted" && (
                <div className="flex-1 flex flex-col items-center justify-center gap-6 py-16">
                  {emptyStateExtras ?? <span className={v.emptyState}>{placeholder}</span>}
                </div>
              )}

              {messages.map((msg, msgIndex) => msgIndex < collapse ? null : (
                <MessageRow
                  key={msg.id || `msg-${msgIndex}`}
                  msg={msgIndex === analysisOnlyIndex && analysisOnlyMsg ? analysisOnlyMsg : msg}
                  msgIndex={msgIndex}
                  showSeparator={msgIndex > collapse}
                  isAnimating={msg.id === lastId}
                  progressStore={progressStore}
                  variant={variant}
                  sourceTitle={sourceTitle}
                  sourceCreatedAt={sourceCreatedAt}
                  resolveSourceTitle={resolveSourceTitle}
                  renderMessage={renderMessage}
                />
              ))}

              {showThinkingDots && (
                <div className={pad}>
                  {messages.length > 0 && <div className={v.separator} />}
                  <ThinkingDots className={v.thinking} />
                </div>
              )}

              {!readOnly && !inputDisabled && needsContinue && (
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

              {!readOnly && !inputDisabled && error && (
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
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map((a, i) => (
                <div key={i} className="relative group/att">
                  {a.url ? (
                    <img src={a.url} alt={a.file.name} className="h-14 w-14 object-cover rounded border border-[#d4d2cd]" />
                  ) : (
                    <div className="flex items-center gap-1.5 h-14 px-2.5 rounded border border-[#d4d2cd] bg-[#f5f4f0] text-xs text-[#444444] font-sans max-w-[180px]">
                      <AttachFileIcon />
                      <span className="truncate">{a.file.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    aria-label={`Remove ${a.file.name}`}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-[#2c2c2c] text-white text-[10px] leading-none opacity-0 group-hover/att:opacity-100 transition-opacity"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {attachError && (
            <div className="text-xs text-[#b33a2a] mb-2 font-sans">{attachError}</div>
          )}
          <div className={variant === "full" ? "flex gap-3 items-start" : "flex gap-2"}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              className="hidden"
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={inputDisabled}
              aria-label="Attach files"
              title="Attach files"
              className="shrink-0 px-3 py-2.5 rounded text-[#666666] hover:text-[#2b5ea7] hover:bg-[#eaf0f8] transition-colors disabled:opacity-50"
            >
              <AttachFileIcon size={18} />
            </button>
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
              onPaste={(e) => {
                if (e.clipboardData.files?.length) {
                  e.preventDefault();
                  addFiles(e.clipboardData.files);
                }
              }}
              placeholder={placeholder}
              rows={1}
              autoFocus
              disabled={inputDisabled}
              className={v.textarea}
            />
            {isLoading ? (
              <button type="button" onClick={handleStop} aria-label="Stop generating" className={v.stopBtn}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={(!input.trim() && attachments.length === 0) || inputDisabled}
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

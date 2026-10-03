import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useImperativeHandle,
  forwardRef,
  memo,
  startTransition,
  type ReactNode,
} from "react";
import { useChat, Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProgressStore } from "../../lib/progress-store";
import { useChatScroll, useEscapeToStop, useFileDrop } from "../../lib/hooks";
import { handleProgressData, stopChat, useCompactedMessages } from "../../lib/chat-utils";
import { WEB_CONFIG } from "../../lib/config";
import { preloadResultChunks } from "../charts/ResultView";
import { AlertSummaryPanel, alertSummaryOf } from "./AlertSummaryPanel";
import { WorkingIndicator } from "./ChatIndicators";
import { Composer, type Attachment } from "./Composer";
import { FollowUpTimerBar } from "./FollowUpTimerBar";
import { MessageView, textOf, type MessageViewOptions } from "./MessageView";
import { Transcript } from "./Transcript";
import type { SourceMeta } from "./MessageActions";

const INITIAL_ROWS = 2;
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

// Empty type allowed: many text files report no MIME type.
const isAttachable = (type: string) =>
  type === "" || type.startsWith("image/") || type.startsWith("text/") || type === "application/pdf" || type === "application/json";

export type RenderView = (options?: MessageViewOptions) => ReactNode;

interface ChatCoreProps {
  chatId: string;
  apiEndpoint: string;
  placeholder?: string;
  extraBody?: Record<string, unknown>;
  onData?: (part: { type: string; data: unknown }) => void;
  initialMessages?: UIMessage[];
  onStatusChange?: (status: string, messages: UIMessage[]) => void;
  initialInput?: string;
  onBeforeStop?: (ctx: { messages: UIMessage[]; progressStore: ProgressStore }) => void;
  variant?: "full" | "panel";

  header?: ReactNode;
  /** Rendered first inside the scroll container (e.g. the sticky session header). */
  scrollHeader?: ReactNode;
  /** Rendered above the message list (e.g. the compaction summary). */
  beforeMessages?: ReactNode;
  /** Hide the first N messages (render-only: state and requests keep the full list). */
  collapseCount?: number;
  /** Render only the analysis section of this message: a kept compaction boundary the summary already covers. */
  analysisOnlyIndex?: number;
  /** Replaces the whole chat while there are no messages; receives the composer to place. */
  emptyState?: (composer: ReactNode) => ReactNode;
  /** Shown in the message list while it is empty; defaults to the placeholder. */
  emptyHint?: ReactNode;
  /** Composer toolbar slots. */
  sources?: ReactNode;
  cost?: ReactNode;
  renderMessage?: (msg: UIMessage, index: number, view: RenderView) => ReactNode;

  /** When true, hide the composer, Continue button, and Retry. */
  readOnly?: boolean;
  /** Replaces the composer when read-only. */
  readOnlyNotice?: ReactNode;
  /** When true, keep the composer visible but block all sending (e.g. while compacting). */
  inputDisabled?: boolean;
  /** Truncates the persisted copy to the kept count before Retry re-sends; without it the no-reply Retry is hidden. */
  onRetryTruncate?: (keepCount: number) => Promise<unknown>;

  /** Embedded in downloaded reply images so they re-import with their origin. */
  sourceTitle?: string;
  sourceCreatedAt?: number;
  resolveSourceTitle?: () => Promise<string | undefined>;

  className?: string;
}

export interface ChatCoreRef {
  readonly messages: UIMessage[];
  setMessages: (msgs: UIMessage[]) => void;
  sendMessage: (msg: { text: string }) => void;
  scrollToBottom: (opts?: { animation?: "instant" | "smooth" }) => void;
  scrollToTop: (opts?: { animation?: "instant" | "smooth" }) => void;
  readonly streaming: boolean;
  stop: () => void;
}

// Memoized so a streaming chunk only re-renders the row whose message object changed.
const MessageRow = memo(function MessageRow({
  msg,
  msgIndex,
  isLast,
  isAnimating,
  progressStore,
  compact,
  meta,
  renderMessage,
}: {
  msg: UIMessage;
  msgIndex: number;
  isLast: boolean;
  isAnimating: boolean;
  progressStore: ProgressStore;
  compact: boolean;
  meta: SourceMeta;
  renderMessage?: ChatCoreProps["renderMessage"];
}) {
  const view: RenderView = (options) => (
    <MessageView msg={msg} isAnimating={isAnimating} progressStore={progressStore} compact={compact} meta={meta} {...options} />
  );
  // Off-screen replies skip layout/paint. The last row stays live for streaming; user rows stay unclipped for their floating actions.
  return (
    <div className={isLast || msg.role === "user" ? undefined : "[content-visibility:auto] [contain-intrinsic-size:auto_600px]"}>
      {renderMessage ? renderMessage(msg, msgIndex, view) : view()}
    </div>
  );
});

function NoticeRow({ tone = "default", children, action }: { tone?: "default" | "error"; children: ReactNode; action: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm",
        tone === "error" ? "border-destructive/25 bg-destructive-tint text-destructive" : "bg-card text-ink-2",
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export const ChatCore = forwardRef<ChatCoreRef, ChatCoreProps>(function ChatCore(
  {
    chatId,
    apiEndpoint,
    placeholder = "Send a message",
    extraBody,
    onData,
    initialMessages,
    onStatusChange,
    initialInput = "",
    onBeforeStop,
    variant = "full",
    header,
    scrollHeader,
    beforeMessages,
    collapseCount = 0,
    analysisOnlyIndex,
    emptyState,
    emptyHint,
    sources,
    cost,
    renderMessage,
    readOnly = false,
    readOnlyNotice,
    inputDisabled = false,
    onRetryTruncate,
    sourceTitle,
    sourceCreatedAt,
    resolveSourceTitle,
    className,
  },
  ref,
) {
  const [input, setInput] = useState(initialInput);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const progressStore = useRef(new ProgressStore()).current;
  const compact = variant === "panel";
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    const ok = list.filter((f) => isAttachable(f.type) && f.size <= MAX_ATTACH_BYTES);
    if (ok.length < list.length) toast.error("Some files were skipped", { description: "Unsupported type or over 10 MB." });
    if (ok.length) {
      setAttachments((prev) => [...prev, ...ok.map((f) => ({ file: f, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }))]);
    }
  }, []);

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => {
      const url = prev[idx]?.url;
      if (url) URL.revokeObjectURL(url);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // Revoke any still-pending thumbnail URLs on unmount.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => { attachmentsRef.current.forEach((a) => a.url && URL.revokeObjectURL(a.url)); }, []);

  const { dragActive, dropProps } = useFileDrop(addFiles, !readOnly && !inputDisabled);

  // Long sessions paint the last rows first; older rows follow right after (auto-follow keeps the bottom anchored).
  const [showAll, setShowAll] = useState(() => (initialMessages?.length ?? 0) <= INITIAL_ROWS);
  useEffect(() => {
    preloadResultChunks();
    if (showAll) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      timer = setTimeout(() => startTransition(() => setShowAll(true)), 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const extraBodyRef = useRef(extraBody);
  extraBodyRef.current = extraBody;

  // Chat instance: stable per mount (the component is keyed externally).
  const chat = useMemo(
    () =>
      new Chat({
        id: chatId,
        messages: initialMessages,
        transport: new DefaultChatTransport({
          api: apiEndpoint,
          prepareSendMessagesRequest: ({ id, messages }) => ({
            body: { id, message: messages[messages.length - 1], ...extraBodyRef.current },
          }),
        }),
        onData: (part) => {
          if (part.type === "data-provider-part") {
            handleProgressData(progressStore, part.data as { toolCallId: string; part: { type: string; [key: string]: unknown } });
          }
          onDataRef.current?.(part as { type: string; data: unknown });
        },
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const { messages, setMessages, status, sendMessage, stop, error } = useChat({ chat, throttle: WEB_CONFIG.chatThrottleMs });
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const isLoading = status === "submitted" || status === "streaming";
  const showEmptyState = !!emptyState && messages.length === 0 && status !== "submitted";
  const { scrollRef, contentRef, isAtBottom, scrollToBottom, scrollToTop } = useChatScroll(showEmptyState);

  const { collapse, analysisOnlyMsg } = useCompactedMessages(messages, collapseCount, analysisOnlyIndex);
  const firstRow = showAll ? collapse : Math.max(collapse, messages.length - INITIAL_ROWS);

  const alert = useMemo(() => (compact ? null : alertSummaryOf(messages)), [compact, messages]);
  const meta = useMemo<SourceMeta>(() => ({ sourceTitle, sourceCreatedAt, resolveSourceTitle }), [sourceTitle, sourceCreatedAt, resolveSourceTitle]);

  const prevStatus = useRef(status);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  useEffect(() => {
    if (prevStatus.current !== status) {
      if (status === "ready") {
        progressStore.clear();
        // Don't steal focus from elsewhere on the page (sidebar, settings, another input).
        const active = document.activeElement;
        if (!active || active === document.body || rootRef.current?.contains(active)) textareaRef.current?.focus();
      }
      onStatusChangeRef.current?.(status, messagesRef.current);
    }
    prevStatus.current = status;
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // `messages.length > collapse` keeps the notice off an interrupted message that is collapsed out of view.
  const lastMessage = messages[messages.length - 1];
  const lastPart = lastMessage?.parts[lastMessage.parts.length - 1];
  const needsContinue = !isLoading && messages.length > collapse && lastMessage?.role === "assistant" && lastPart?.type.startsWith("tool-");

  const lastPartState = (lastPart as { state?: string } | undefined)?.state;
  const isSubAgentRunning = lastPart?.type.startsWith("tool-") && lastPartState !== "output-available";
  const isContentStreaming = lastPart?.type === "text" || lastPart?.type === "reasoning";
  const showWorking = status === "submitted" || (status === "streaming" && !isContentStreaming && !isSubAgentRunning);

  const lastId = status === "streaming" ? lastMessage?.id : null;
  const canRetry = !readOnly && !inputDisabled && !isLoading;

  const handleStop = () => {
    onBeforeStop?.({ messages, progressStore });
    void stopChat(chatId);
    stop();
  };
  useEscapeToStop(isLoading, handleStop);
  const stopRef = useRef({ isLoading, handleStop });
  stopRef.current = { isLoading, handleStop };

  // Disabling a focused textarea drops focus to <body>; restore it when the lock releases.
  const prevInputDisabled = useRef(inputDisabled);
  useEffect(() => {
    if (prevInputDisabled.current && !inputDisabled) textareaRef.current?.focus();
    prevInputDisabled.current = inputDisabled;
  }, [inputDisabled]);

  const canSend = !!input.trim() || attachments.length > 0;
  const handleSubmit = () => {
    const text = input.trim();
    if (!canSend || isLoading || inputDisabled) return;
    setInput("");
    scrollToBottom({ animation: "instant" });
    if (attachments.length > 0) {
      // A file-only turn keeps a default instruction so title generation, which keys on a text part, still fires.
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

  // Retry the last user message: after an error, or when a turn ended with no reply.
  const onRetryTruncateRef = useRef(onRetryTruncate);
  onRetryTruncateRef.current = onRetryTruncate;
  const handleRetry = useCallback(async () => {
    const msgs = messagesRef.current;
    const userIdx = msgs.findLastIndex((m) => m.role === "user");
    const msg = msgs[userIdx];
    const text = msg ? textOf(msg) : "";
    if (!text) return;
    // The failed message may be persisted already; trim it server-side too or the re-send duplicates it.
    try {
      await onRetryTruncateRef.current?.(userIdx);
    } catch {
      toast.error("Couldn't retry. Try again.");
      return;
    }
    const files = msg.parts.filter((p): p is FileUIPart => p.type === "file");
    setMessages(msgs.slice(0, userIdx));
    scrollToBottom({ animation: "instant" });
    sendMessageRef.current({ text, files });
  }, [setMessages, scrollToBottom]);

  useImperativeHandle(
    ref,
    () => ({
      get messages() { return messagesRef.current; },
      setMessages,
      sendMessage: (msg) => sendMessageRef.current(msg),
      scrollToBottom,
      scrollToTop,
      get streaming() { return stopRef.current.isLoading; },
      stop: () => stopRef.current.handleStop(),
    }),
    [setMessages, scrollToBottom, scrollToTop],
  );

  const composer = !readOnly ? (
    <Composer
      value={input}
      onChange={setInput}
      onSubmit={handleSubmit}
      placeholder={placeholder}
      canSend={canSend}
      streaming={isLoading}
      onStop={handleStop}
      disabled={inputDisabled}
      attachments={attachments}
      onAttach={addFiles}
      onRemoveAttachment={removeAttachment}
      sources={sources}
      cost={cost}
      textareaRef={textareaRef}
      autoFocus
      compact={compact}
    />
  ) : null;

  const dropOverlay = dragActive && (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary-tint/70">
      <span className="rounded-md bg-card px-4 py-2 text-sm font-medium text-primary shadow-sm">Drop to attach</span>
    </div>
  );

  if (emptyState && showEmptyState) {
    return (
      <div ref={rootRef} className={cn("relative h-full overflow-y-auto", className)} {...dropProps}>
        {dropOverlay}
        {emptyState(composer)}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={cn("relative flex h-full flex-col", className)} {...dropProps}>
      {dropOverlay}
      {header}

      <Transcript
        scrollRef={scrollRef}
        contentRef={contentRef}
        isAtBottom={isAtBottom}
        scrollToBottom={scrollToBottom}
        header={scrollHeader}
        compact={compact}
        dock={
          <>
            <FollowUpTimerBar sessionId={chatId} />
            {composer ?? readOnlyNotice}
          </>
        }
      >
        {alert && <AlertSummaryPanel summary={alert.summary} triage={alert.triage} />}
        {beforeMessages}
        {messages.length === 0 && status !== "submitted" && (
          emptyHint ?? <p className="py-16 text-center text-sm text-muted-foreground">{placeholder}</p>
        )}
        {messages.map((msg, msgIndex) => msgIndex < firstRow ? null : (
          <MessageRow
            key={msg.id || `msg-${msgIndex}`}
            msg={msgIndex === analysisOnlyIndex && analysisOnlyMsg ? analysisOnlyMsg : msg}
            msgIndex={msgIndex}
            isLast={msgIndex === messages.length - 1}
            isAnimating={msg.id === lastId}
            progressStore={progressStore}
            compact={compact}
            meta={meta}
            renderMessage={renderMessage}
          />
        ))}
        {showWorking && <WorkingIndicator label="Investigating" />}
        {!readOnly && !inputDisabled && needsContinue && (
          <NoticeRow action={<Button variant="outline" size="sm" onClick={handleContinue}>Continue</Button>}>
            The reply was interrupted.
          </NoticeRow>
        )}
        {canRetry && !error && onRetryTruncate && lastMessage?.role === "user" && (
          <NoticeRow action={<Button variant="outline" size="sm" onClick={handleRetry}>Retry</Button>}>
            No reply to this message.
          </NoticeRow>
        )}
        {canRetry && error && (
          <NoticeRow tone="error" action={<Button variant="outline" size="sm" onClick={handleRetry}>Retry</Button>}>
            {error.message}
          </NoticeRow>
        )}
      </Transcript>
    </div>
  );
});

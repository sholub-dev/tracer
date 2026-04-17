import React, { useState, useRef, useEffect, useMemo, useCallback, createRef } from "react";
import type { UIMessage } from "ai";
import { theme } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { LiveStreamView } from "../components/chat/LiveStreamView";
import { ChatCore, type ChatCoreRef } from "../components/chat/ChatCore";
import { CopyMessageButton } from "../components/chat/CopyMessageButton";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { ProviderToggle } from "../components/ui/ProviderToggle";
import { DEFAULT_SESSION_TITLE, ImportedAnalysisSchema, SESSION_KIND } from "@tracer-sh/shared";
import { SessionTitle } from "../components/debug/SessionTitle";
import { CostDisplay, computeCostBreakdown, type CostBreakdown } from "../components/debug/CostDisplay";
import { EditMessageForm } from "../components/debug/EditMessageForm";
import { decodePngPayload } from "../lib/png-steg";

interface DebugProps {
  sessionId: string | null;
  onSessionChange: (id: string) => void;
}

export function Debug({ sessionId, onSessionChange }: DebugProps) {
  const resolvedId = useMemo(() => sessionId ?? crypto.randomUUID(), [sessionId]);

  useEffect(() => {
    if (!sessionId) onSessionChange(resolvedId);
  }, [sessionId, resolvedId, onSessionChange]);

  // ── Drag-and-drop import ─────────────────────────────────────────────
  const [dragCounter, setDragCounter] = useState(0);
  const [dropError, setDropError] = useState<string | null>(null);
  const importMutation = trpc.sessions.importAnalysis.useMutation();
  const dropUtils = trpc.useUtils();

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragCounter(0);
    const files = e.dataTransfer.files;
    if (!files || files.length !== 1 || files[0].type !== "image/png") {
      setDropError("Only single PNG files are supported.");
      return;
    }
    const file = files[0];
    if (file.size > 10 * 1024 * 1024) {
      setDropError("PNG is too large (>10 MB).");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let payload: Uint8Array | null;
      try {
        payload = await decodePngPayload(bytes);
      } catch {
        setDropError("Not a valid PNG file.");
        return;
      }
      if (!payload) {
        setDropError("No analysis data found in this image.");
        return;
      }
      let parsed;
      try {
        parsed = ImportedAnalysisSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        setDropError("Analysis data is malformed or from an incompatible version.");
        return;
      }
      const { id } = await importMutation.mutateAsync(parsed);
      dropUtils.sessions.list.setData(undefined, (prev) => {
        const row = {
          id,
          title: parsed.sourceTitle.slice(0, 80) || DEFAULT_SESSION_TITLE,
          status: "idle" as const,
          kind: SESSION_KIND.IMPORTED as string | null,
          updatedAt: Math.floor(Date.now() / 1000),
          titlePending: false,
        };
        return prev ? [row, ...prev] : [row];
      });
      setDropError(null);
      onSessionChange(id);
    } catch {
      setDropError("Couldn't import analysis.");
    }
  }, [importMutation, dropUtils, onSessionChange]);

  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      setDragCounter((c) => c + 1);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
    },
    onDragLeave: () => setDragCounter((c) => Math.max(0, c - 1)),
    onDrop: handleDrop,
  };

  const dropOverlay = dragCounter > 0 ? (
    <div
      className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center bg-[#2b5ea7]/10 border-2 border-dashed border-[#2b5ea7] rounded"
    >
      <span className="text-sm font-medium text-[#2b5ea7] bg-white/90 px-4 py-2 rounded shadow-sm">
        Drop PNG to import analysis
      </span>
    </div>
  ) : null;

  const dropBanner = dropError ? (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-40 text-sm text-[#b33a2a] bg-[#b33a2a]/5 border border-[#b33a2a]/20 rounded px-4 py-2 flex items-center gap-3 shadow-sm">
      <span>{dropError}</span>
      <button
        type="button"
        onClick={() => setDropError(null)}
        className="text-xs underline shrink-0 font-sans"
      >
        dismiss
      </button>
    </div>
  ) : null;

  const [activeProvider, setActiveProviderRaw] = useState<string | null>(
    () => localStorage.getItem("tracer:activeProvider"),
  );
  const setActiveProvider = useCallback((type: string) => {
    localStorage.setItem("tracer:activeProvider", type);
    setActiveProviderRaw(type);
  }, []);

  const utils = trpc.useUtils();
  const markViewed = trpc.sessions.markViewed.useMutation();

  // Mark session as viewed immediately on select — optimistically update caches
  useEffect(() => {
    if (!sessionId) return;
    const listData = utils.sessions.list.getData();
    const session = listData?.find((s) => s.id === sessionId);
    if (!session || session.status === "idle" || session.status === "streaming") return;

    // Optimistically clear the per-session indicator in the list cache
    utils.sessions.list.setData(undefined, (prev) =>
      prev?.map((s) => (s.id === sessionId ? { ...s, status: "idle" } : s)),
    );
    // Optimistically decrement the nav badge count
    utils.sessions.activeCount.setData(undefined, (prev) =>
      prev ? { ...prev, done: Math.max(0, prev.done - 1) } : prev,
    );
    markViewed.mutate({ id: sessionId });
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionQuery = trpc.sessions.get.useQuery(
    { id: resolvedId },
    { enabled: !!sessionId, gcTime: 0 },
  );

  const initialMessages = sessionQuery.data?.messages as UIMessage[] | undefined;

  // Separate cost query — decoupled from sessions.get so invalidating cost
  // data after streaming never triggers the loading state that unmounts the chat.
  const costQuery = trpc.sessions.getCost.useQuery(
    { id: resolvedId },
    { enabled: !!sessionId },
  );
  const costBreakdown = useMemo(() => {
    const d = costQuery.data;
    if (!d?.agents?.length) return null;
    return computeCostBreakdown(d.agents);
  }, [costQuery.data]);

  // Wait for session data to load when resuming
  let body: React.ReactNode;
  if (sessionId && sessionQuery.isLoading) {
    body = (
      <div className={theme.chatContainer}>
        <div className="flex items-center justify-center h-full">
          <span className={theme.chatEmptyState}>Loading session...</span>
        </div>
      </div>
    );
  } else if (sessionQuery.data?.status === "streaming") {
    body = (
      <LiveStreamView
        key={resolvedId}
        sessionId={resolvedId}
        initialMessages={initialMessages ?? []}
        onComplete={() => sessionQuery.refetch()}
        header={<SessionTitle chatId={resolvedId} hasMessages isLoading={false} onPostMortem={() => {}} streaming />}
        beforeInput={<div className="px-10 pt-2 flex justify-end"><ProviderToggle activeProvider={activeProvider} onToggle={setActiveProvider} /></div>}
      />
    );
  } else if (sessionQuery.data?.kind === SESSION_KIND.IMPORTED) {
    body = (
      <ImportedView
        key={resolvedId}
        sessionId={resolvedId}
        sessionTitle={sessionQuery.data.title}
        initialMessages={initialMessages ?? []}
      />
    );
  } else {
    body = (
      <DebugChat
        key={resolvedId}
        chatId={resolvedId}
        initialMessages={initialMessages}
        costBreakdown={costBreakdown}
        activeProvider={activeProvider}
        setActiveProvider={setActiveProvider}
        sessionTitle={sessionQuery.data?.title}
        sessionUpdatedAt={sessionQuery.data?.updatedAt}
      />
    );
  }

  return (
    <div className="relative h-full" {...dropHandlers}>
      {body}
      {dropBanner}
      {dropOverlay}
    </div>
  );
}

// ── Read-only view for imported sessions ─────────────────────────────────────

interface ImportedViewProps {
  sessionId: string;
  sessionTitle: string;
  initialMessages: UIMessage[];
}

function ImportedView({ sessionId, sessionTitle, initialMessages }: ImportedViewProps) {
  const coreRef = useRef<ChatCoreRef>(null);
  const first = initialMessages[0] as UIMessage & {
    metadata?: { sourceTitle?: string; sourceCreatedAt?: number };
  } | undefined;
  const sourceTitle = first?.metadata?.sourceTitle ?? sessionTitle;
  const sourceCreatedAt = first?.metadata?.sourceCreatedAt;

  const formattedDate = useMemo(() => {
    if (!sourceCreatedAt) return "";
    try {
      return new Date(sourceCreatedAt * 1000).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
      });
    } catch {
      return "";
    }
  }, [sourceCreatedAt]);

  const banner = (
    <div className={theme.titleBar}>
      {sourceTitle && <h2 className={theme.titleText}>{sourceTitle}</h2>}
      <div className="text-xs text-[#9c9890] mt-1">
        Imported{formattedDate ? ` · originally ${formattedDate}` : ""}
      </div>
    </div>
  );

  return (
    <div className={theme.chatContainer}>
      <ChatCore
        ref={coreRef}
        chatId={sessionId}
        apiEndpoint="/api/chat"
        initialMessages={initialMessages}
        variant="full"
        readOnly
        sourceTitle={sourceTitle}
        sourceCreatedAt={sourceCreatedAt}
        scrollHeader={banner}
      />
    </div>
  );
}

interface DebugChatProps {
  chatId: string;
  initialMessages?: UIMessage[];
  costBreakdown: CostBreakdown | null;
  activeProvider: string | null;
  setActiveProvider: (type: string) => void;
  sessionTitle?: string;
  sessionUpdatedAt?: number;
}

function DebugChat({ chatId, initialMessages, costBreakdown, activeProvider, setActiveProvider, sessionTitle, sessionUpdatedAt }: DebugChatProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasMessages, setHasMessages] = useState(!!initialMessages?.length);
  const [needsRetry, setNeedsRetry] = useState(() => {
    if (!initialMessages?.length) return false;
    return initialMessages[initialMessages.length - 1]?.role === "user";
  });
  const coreRef = useRef<ChatCoreRef>(null);
  const hasMarkedViewed = useRef(false);
  const utils = trpc.useUtils();
  const markViewed = trpc.sessions.markViewed.useMutation();
  const truncateMessages = trpc.sessions.truncateMessages.useMutation();
  const saveMessages = trpc.sessions.saveMessages.useMutation();

  const resolveSourceTitle = useCallback(async () => {
    const fresh = await utils.sessions.get.fetch({ id: chatId });
    return fresh?.title;
  }, [utils, chatId]);

  const handleRetry = () => {
    if (!coreRef.current) return;
    const msgs = coreRef.current.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") return;
    const textPart = last.parts.find((p) => p.type === "text");
    if (!textPart || textPart.type !== "text") return;
    coreRef.current.setMessages(msgs.slice(0, -1));
    coreRef.current.scrollToBottom({ animation: "instant" });
    coreRef.current.sendMessage({ text: textPart.text });
  };

  const handlePostMortem = () => {
    if (!coreRef.current) return;
    coreRef.current.scrollToBottom({ animation: "instant" });
    coreRef.current.sendMessage({
      text: `Generate a Post-Mortem Report for this investigation session.

Structure it with these sections:
- **Summary**: Concise overview of the incident and key findings
- **Impact**: Quantified impact based on data discovered (error rates, affected services, latency, etc.)
- **Timeline**: Chronological sequence of key events and findings with timestamps
- **Root Cause**: Technical explanation of what caused the issue
- **Resolution**: What fixed the issue or recommended next steps

Base the report entirely on the investigation data and findings from this conversation. Be specific — include actual error messages, metric values, service names, and query results where relevant.`,
    });
  };

  const handleDelete = (index: number) => {
    setDeleteTarget(index);
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget === null || !coreRef.current) return;
    await truncateMessages.mutateAsync({ id: chatId, keepCount: deleteTarget });
    coreRef.current.setMessages(coreRef.current.messages.slice(0, deleteTarget));
    setDeleteTarget(null);
  };

  const handleStartEdit = (index: number) => {
    const msg = coreRef.current?.messages[index];
    const textPart = msg?.parts.find((p) => p.type === "text");
    if (!textPart || textPart.type !== "text") return;
    setEditingIndex(index);
    setEditText(textPart.text);
  };

  const handleEditCancel = () => {
    setEditingIndex(null);
  };

  const handleEditSubmit = async (text: string) => {
    if (editingIndex === null || !text.trim() || !coreRef.current) return;
    const trimmed = text.trim();
    await truncateMessages.mutateAsync({ id: chatId, keepCount: editingIndex });
    coreRef.current.setMessages(coreRef.current.messages.slice(0, editingIndex));
    setEditingIndex(null);
    coreRef.current.scrollToBottom({ animation: "instant" });
    coreRef.current.sendMessage({ text: trimmed });
  };

  const handleBeforeStop = ({ messages: msgs, progressStore }: { messages: UIMessage[]; progressStore: import("../lib/progress-store").ProgressStore }) => {
    // Bake in-memory sub-agent progress into tool parts before saving,
    // so partial results survive a page refresh.
    const enrichedMessages = msgs.map((msg) => {
      if (msg.role !== "assistant") return msg;
      const enrichedParts = msg.parts.map((part) => {
        const p = part as Record<string, unknown>;
        if (p.toolCallId && p.state !== "output-available") {
          const progress = progressStore.getSnapshot(p.toolCallId as string);
          const output = progress?.parts?.length
            ? { parts: progress.parts }
            : { error: "Aborted" };
          return { ...p, state: "output-available", output };
        }
        return part;
      });
      return { ...msg, parts: enrichedParts };
    });
    saveMessages.mutate({ id: chatId, messages: enrichedMessages });
  };

  // Stable refs so renderMessage doesn't re-create during streaming
  const handleStartEditRef = useRef(handleStartEdit);
  handleStartEditRef.current = handleStartEdit;
  const handleDeleteRef = useRef(handleDelete);
  handleDeleteRef.current = handleDelete;
  const handleEditSubmitRef = useRef(handleEditSubmit);
  handleEditSubmitRef.current = handleEditSubmit;
  const handleEditCancelRef = useRef(handleEditCancel);
  handleEditCancelRef.current = handleEditCancel;

  const renderMessage = useCallback(
    (msg: UIMessage, index: number, { label, content }: { label: React.ReactNode; content: React.ReactNode }) => {
      const contentRef = createRef<HTMLDivElement>();
      return (
        <div className="relative group">
          {/* Action buttons — hidden during streaming or editing */}
          {!isStreaming && editingIndex === null && (
            <div className={theme.chatMessageActions}>
              <CopyMessageButton contentRef={contentRef} parts={msg.parts} />
              {msg.role === "user" && (
                <button
                  type="button"
                  onClick={() => handleStartEditRef.current(index)}
                  className={theme.chatActionButton}
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                    <path d="m15 5 4 4"/>
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => handleDeleteRef.current(index)}
                className={theme.chatActionButton}
                title="Delete this message and everything after it"
                aria-label="Delete message"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                </svg>
              </button>
            </div>
          )}

          {/* Inline edit mode */}
          {editingIndex === index ? (
            <EditMessageForm
              initialText={editText}
              onSave={(text) => handleEditSubmitRef.current(text)}
              onCancel={() => handleEditCancelRef.current()}
            />
          ) : (
            <div ref={contentRef} className={theme.chatMessageCard}>
              {label}
              {content}
            </div>
          )}
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isStreaming, editingIndex], // editText omitted: only changes in the same batch as editingIndex
  );

  const refreshCostData = useCallback(() => {
    utils.sessions.getCost.invalidate({ id: chatId });
  }, [utils, chatId]);

  const sessionTitleHeader = (
    <SessionTitle
      chatId={chatId}
      hasMessages={hasMessages}
      isLoading={isStreaming}
      onPostMortem={handlePostMortem}
      streaming={isStreaming}
      onCostDataReady={refreshCostData}
      onTitleClick={() => coreRef.current?.scrollToTop({ animation: "smooth" })}
    />
  );

  const emptyStateNotifiers = (
    <ul className="max-w-md space-y-4 text-sm text-[#b8b5af] font-serif text-center">
      <li>
        <div className="text-[#9c9890]">Garbage in, garbage out.</div>
        <div>The clearer your question, the sharper the answer — vague ones can still work.</div>
      </li>
      <li>
        <div className="text-[#9c9890]">Models hallucinate.</div>
        <div>Don't take every claim at face value — verify the parts that matter.</div>
      </li>
      <li>
        <div className="text-[#9c9890]">Self-review still matters.</div>
        <div>Don't share findings with teammates until you've checked them yourself.</div>
      </li>
    </ul>
  );

  return (
    <div className={theme.chatContainer}>
      <ChatCore
        ref={coreRef}
        chatId={chatId}
        apiEndpoint="/api/chat"
        placeholder="Ask a debugging question..."
        initialMessages={initialMessages}
        variant="full"
        sourceTitle={sessionTitle}
        sourceCreatedAt={sessionUpdatedAt}
        resolveSourceTitle={resolveSourceTitle}
        scrollHeader={sessionTitleHeader}
        emptyStateExtras={emptyStateNotifiers}
        onBeforeStop={handleBeforeStop}
        onStatusChange={(status, msgs) => {
          const loading = status === "submitted" || status === "streaming";
          setIsStreaming(loading);
          if (loading) hasMarkedViewed.current = false;
          if (msgs.length > 0) setHasMessages(true);
          const last = msgs[msgs.length - 1];
          setNeedsRetry(!loading && msgs.length > 0 && last?.role === "user");
          if (status === "submitted") {
            let added = false;
            utils.sessions.list.setData(undefined, (prev) => {
              if (!prev || prev.some((s) => s.id === chatId)) return prev;
              added = true;
              return [{ id: chatId, title: DEFAULT_SESSION_TITLE, status: "streaming", kind: null, updatedAt: Math.floor(Date.now() / 1000), titlePending: true }, ...prev];
            });
            if (added) {
              utils.sessions.activeCount.setData(undefined, (prev) =>
                prev ? { ...prev, streaming: prev.streaming + 1 } : prev,
              );
            }
          }
          if (status === "ready") {
            if (!hasMarkedViewed.current) {
              hasMarkedViewed.current = true;
              markViewed.mutate({ id: chatId });
            }
            utils.sessions.getCost.invalidate({ id: chatId });
            // Only refetch for a title update while the title is still pending
            // — avoids a round-trip on every completion of a named session.
            if (sessionTitle === DEFAULT_SESSION_TITLE) {
              utils.sessions.get.invalidate({ id: chatId });
            }
          }
        }}
        extraBody={activeProvider ? { activeProvider } : undefined}
        beforeInput={
          costBreakdown && (costBreakdown.totalInput > 0 || costBreakdown.totalOutput > 0)
            ? <CostDisplay breakdown={costBreakdown} activeProvider={activeProvider} onToggle={setActiveProvider} />
            : <div className="px-10 pt-2 flex justify-end"><ProviderToggle activeProvider={activeProvider} onToggle={setActiveProvider} /></div>
        }
        afterMessages={
          needsRetry ? (
            <div className="flex justify-center mt-4">
              <button
                type="button"
                onClick={handleRetry}
                className={theme.chatContinueButton}
              >
                Retry
              </button>
            </div>
          ) : undefined
        }
        renderMessage={renderMessage}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete messages"
        message="This message and all messages after it will be removed. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

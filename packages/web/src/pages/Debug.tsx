import React, { useState, useRef, useEffect, useMemo, useCallback, createRef } from "react";
import type { UIMessage } from "ai";
import { theme } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { LiveStreamView } from "../components/chat/LiveStreamView";
import { ChatCore, type ChatCoreRef } from "../components/chat/ChatCore";
import { CopyMessageButton } from "../components/chat/CopyMessageButton";
import { SessionSummaryBlock } from "../components/chat/SessionSummaryBlock";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { ProviderToggle } from "../components/ui/ProviderToggle";
import { DEFAULT_SESSION_TITLE, SESSION_KIND, UNIFIED_SCOPE, analysisSectionParts, compactionUpTo, isAnalysisMessage } from "@tracer-sh/shared";
import { SessionTitle } from "../components/debug/SessionTitle";
import { CostDisplay, computeCostBreakdown, type CostBreakdown } from "../components/debug/CostDisplay";
import { EditMessageForm } from "../components/debug/EditMessageForm";

interface DebugProps {
  sessionId: string | null;
  onSessionChange: (id: string) => void;
}

export function Debug({ sessionId, onSessionChange }: DebugProps) {
  const resolvedId = useMemo(() => sessionId ?? crypto.randomUUID(), [sessionId]);

  useEffect(() => {
    if (!sessionId) onSessionChange(resolvedId);
  }, [sessionId, resolvedId, onSessionChange]);

  // Default everyone into the cross-provider "ALL" (unified) scope; a stored preference
  // (set when the user picks a specific provider) overrides it and carries across sessions.
  const [activeProvider, setActiveProviderRaw] = useState<string | null>(
    () => localStorage.getItem("tracer:activeProvider") ?? UNIFIED_SCOPE,
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
    const updatedAt = sessionQuery.data?.updatedAt;
    return computeCostBreakdown(d.agents, updatedAt ? updatedAt * 1000 : undefined);
  }, [costQuery.data, sessionQuery.data?.updatedAt]);

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
    // Compacted session: hide summarized messages here too (display-only —
    // LiveStreamView never sends message content anywhere).
    const liveData = sessionQuery.data;
    const liveMsgs = initialMessages ?? [];
    const liveUpTo =
      liveData.summary && liveData.summaryUpTo && liveData.summaryUpTo <= liveMsgs.length
        ? liveData.summaryUpTo
        : 0;
    const liveTail = liveUpTo > 0 ? liveMsgs.slice(liveUpTo) : liveMsgs;
    // A kept analysis boundary heads the tail — show only its analysis
    // section, like the regular compacted view (display-only).
    if (liveUpTo > 0 && liveTail[0]?.role === "assistant") {
      const parts = analysisSectionParts(liveTail[0].parts);
      if (parts) liveTail[0] = { ...liveTail[0], parts };
    }
    body = (
      <LiveStreamView
        key={resolvedId}
        sessionId={resolvedId}
        initialMessages={liveTail}
        onComplete={() => sessionQuery.refetch()}
        header={
          <>
            <SessionTitle chatId={resolvedId} hasMessages isLoading={false} onPostMortem={() => {}} streaming />
            {liveUpTo > 0 && liveData.summary && (
              <div className="px-10">
                <SessionSummaryBlock
                  summary={liveData.summary}
                  summarizedCount={liveUpTo}
                  createdAt={liveData.summaryCreatedAt}
                  readOnly
                />
              </div>
            )}
          </>
        }
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
        summary={sessionQuery.data?.summary}
        summaryUpTo={sessionQuery.data?.summaryUpTo}
        summaryCreatedAt={sessionQuery.data?.summaryCreatedAt}
      />
    );
  }

  return <div className="relative h-full">{body}</div>;
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
  summary?: string | null;
  summaryUpTo?: number | null;
  summaryCreatedAt?: number | null;
}

function DebugChat({ chatId, initialMessages, costBreakdown, activeProvider, setActiveProvider, sessionTitle, sessionUpdatedAt, summary, summaryUpTo, summaryCreatedAt }: DebugChatProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasMessages, setHasMessages] = useState(!!initialMessages?.length);
  // Compaction needs a boundary to pick — without one, selection mode would
  // be a dead end with no buttons.
  const [hasBoundary, setHasBoundary] = useState(
    () => hasCompactBoundary(initialMessages ?? []),
  );
  const [needsRetry, setNeedsRetry] = useState(() => {
    if (!initialMessages?.length) return false;
    return initialMessages[initialMessages.length - 1]?.role === "user";
  });
  const [showOriginals, setShowOriginals] = useState(false);
  // Compacting is a deliberate two-step flow: the header "Compact" button
  // enters selection mode, then the user picks the boundary message.
  const [selectingCompact, setSelectingCompact] = useState(false);
  // In-flight compaction: `upTo` is the exclusive end of the range that gets
  // hidden (the summaryUpTo the server will store); `count` is the number of
  // messages feeding the summary (an analysis boundary stays visible but its
  // tool work is summarized too, so count can exceed upTo).
  const [compacting, setCompacting] = useState<{ upTo: number; count: number } | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);
  const isCompacting = compacting !== null;
  const coreRef = useRef<ChatCoreRef>(null);
  const hasMarkedViewed = useRef(false);
  const utils = trpc.useUtils();
  const markViewed = trpc.sessions.markViewed.useMutation();
  const truncateMessages = trpc.sessions.truncateMessages.useMutation();
  const saveMessages = trpc.sessions.saveMessages.useMutation();
  const compactMutation = trpc.sessions.compact.useMutation();
  const updateSummaryMutation = trpc.sessions.updateSummary.useMutation();
  const clearSummaryMutation = trpc.sessions.clearSummary.useMutation();

  // Drop the summary from the query cache (mirrors a server-side clear, e.g.
  // when a truncation cut into the summarized prefix).
  const clearSummaryCache = () => {
    utils.sessions.get.setData({ id: chatId }, (prev) =>
      prev ? { ...prev, summary: null, summaryUpTo: null, summaryCreatedAt: null } : prev,
    );
    setShowOriginals(false);
  };

  // Truncate the persisted history in lockstep with the client list; the
  // server reports whether the truncation invalidated the summary.
  const truncateTo = async (keepCount: number) => {
    const res = await truncateMessages.mutateAsync({ id: chatId, keepCount });
    if (res.summaryCleared) clearSummaryCache();
  };

  const resolveSourceTitle = useCallback(async () => {
    const fresh = await utils.sessions.get.fetch({ id: chatId });
    return fresh?.title;
  }, [utils, chatId]);

  const handleRetry = async () => {
    if (!coreRef.current) return;
    const msgs = coreRef.current.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") return;
    const textPart = last.parts.find((p) => p.type === "text");
    if (!textPart || textPart.type !== "text") return;
    // The failed user message is already persisted; trim the server copy too
    // so client and server indices stay aligned for later edits/compaction.
    try {
      await truncateTo(msgs.length - 1);
    } catch {
      return; // server unreachable — keep state untouched, Retry stays available
    }
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
    await truncateTo(deleteTarget);
    const kept = coreRef.current.messages.slice(0, deleteTarget);
    coreRef.current.setMessages(kept);
    setHasBoundary(hasCompactBoundary(kept));
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
    if (editingIndex === null || !text.trim() || !coreRef.current || isCompacting) return;
    const trimmed = text.trim();
    await truncateTo(editingIndex);
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

  const handleCompact = async (index: number) => {
    const upTo = compactionUpTo(coreRef.current?.messages ?? [], index);
    if (upTo === null) {
      setCompactError("There are no messages to summarize before the analysis");
      return;
    }
    setSelectingCompact(false);
    setEditingIndex(null); // an open edit form must not truncate/send mid-compaction
    // Incremental re-compaction (mirrors the server): an existing summary
    // with an earlier boundary already covers its prefix — only the delta
    // feeds the summarizer, so only it counts.
    const prior = summary && summaryUpTo != null && summaryUpTo < upTo ? summaryUpTo : 0;
    setCompacting({ upTo, count: index + 1 - prior });
    setCompactError(null);
    try {
      const result = await compactMutation.mutateAsync({ id: chatId, upToIndex: index });
      if (utils.sessions.get.getData({ id: chatId })) {
        utils.sessions.get.setData({ id: chatId }, (prev) => (prev ? { ...prev, ...result } : prev));
      } else {
        // Session created in this view: the cache holds null from before the
        // row existed, so a setData merge would no-op and hide the summary.
        utils.sessions.get.invalidate({ id: chatId });
      }
      utils.sessions.getCost.invalidate({ id: chatId });
      setShowOriginals(false);
    } catch (err) {
      setCompactError(err instanceof Error ? err.message : "Failed to summarize the conversation");
      // The server may still have committed (e.g. the response was lost) — re-sync.
      utils.sessions.get.invalidate({ id: chatId });
    } finally {
      setCompacting(null);
    }
  };

  const handleSummarySave = async (text: string) => {
    if (isCompacting) throw new Error("A summary is being generated");
    await updateSummaryMutation.mutateAsync({ id: chatId, summary: text });
    utils.sessions.get.setData({ id: chatId }, (prev) => (prev ? { ...prev, summary: text } : prev));
  };

  const handleSummaryDelete = () => {
    clearSummaryMutation.mutate(
      { id: chatId },
      {
        onSuccess: () => clearSummaryCache(),
        onError: (err) => setCompactError(err.message || "Failed to delete the summary"),
      },
    );
  };

  // Escape exits compact-selection mode
  useEffect(() => {
    if (!selectingCompact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectingCompact(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectingCompact]);

  // Stable refs so renderMessage doesn't re-create during streaming
  const handleStartEditRef = useRef(handleStartEdit);
  handleStartEditRef.current = handleStartEdit;
  const handleDeleteRef = useRef(handleDelete);
  handleDeleteRef.current = handleDelete;
  const handleCompactRef = useRef(handleCompact);
  handleCompactRef.current = handleCompact;
  const handleEditSubmitRef = useRef(handleEditSubmit);
  handleEditSubmitRef.current = handleEditSubmit;
  const handleEditCancelRef = useRef(handleEditCancel);
  handleEditCancelRef.current = handleEditCancel;

  const renderMessage = useCallback(
    (msg: UIMessage, index: number, { label, content }: { label: React.ReactNode; content: React.ReactNode }) => {
      const contentRef = createRef<HTMLDivElement>();
      // While a summary is being generated, fade out the messages it will hide.
      const dimmed = compacting !== null && index < compacting.upTo;
      return (
        <div className="relative group">
          {/* Action buttons — hidden during streaming, editing, or any stage of
              compaction (a truncate/edit racing the flow would corrupt indices,
              and ConfirmDialog's Escape would collide with selection-mode Escape) */}
          {!isStreaming && editingIndex === null && !selectingCompact && compacting === null && (
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
            <div
              ref={contentRef}
              className={`${theme.chatMessageCard} transition-opacity${dimmed ? " opacity-40 pointer-events-none" : ""}`}
            >
              {label}
              {content}
            </div>
          )}

          {/* Compaction in progress: indicator under the last message that
              will be hidden (an analysis boundary itself stays visible) */}
          {compacting?.upTo === index + 1 && (
            <div className="flex justify-center mt-3">
              <div className={theme.compactionPill}>
                <CompactionSpinner />
                Summarizing up to here…
              </div>
            </div>
          )}

          {/* Compact-selection mode: explicit boundary picker per assistant
              message. An analysis boundary keeps itself, so it needs at least
              one earlier message to summarize (mirrors hasCompactBoundary /
              compactionUpTo). */}
          {selectingCompact && compacting === null && canCompactAt(msg, index) && (
            <div className="flex justify-center mt-3">
              <button
                type="button"
                onClick={() => handleCompactRef.current(index)}
                className={theme.compactionButton}
              >
                Summarize up to here
              </button>
            </div>
          )}
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isStreaming, editingIndex, compacting, selectingCompact], // editText omitted: only changes in the same batch as editingIndex
  );

  const refreshCostData = useCallback(() => {
    utils.sessions.getCost.invalidate({ id: chatId });
  }, [utils, chatId]);

  const sessionTitleHeader = (
    <SessionTitle
      chatId={chatId}
      hasMessages={hasMessages}
      // isCompacting included so Post-Mortem (which sends a message directly,
      // bypassing the disabled composer) can't start a stream mid-compaction.
      isLoading={isStreaming || isCompacting}
      onPostMortem={handlePostMortem}
      onCompact={hasBoundary ? () => setSelectingCompact(true) : undefined}
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
    <div className={`${theme.chatContainer} relative`}>
      {compactError && (
        <TopBanner tone="error">
          <span>{compactError}</span>
          <button
            type="button"
            onClick={() => setCompactError(null)}
            className="text-xs underline shrink-0"
          >
            dismiss
          </button>
        </TopBanner>
      )}
      {selectingCompact && (
        <TopBanner tone="compaction">
          <span>Pick where to compact — that message and everything above it will be summarized (analyses are kept).</span>
          <button
            type="button"
            onClick={() => setSelectingCompact(false)}
            className="text-xs underline shrink-0"
          >
            cancel
          </button>
        </TopBanner>
      )}
      {compacting !== null && (
        <TopBanner tone="compaction">
          <CompactionSpinner />
          <span>Summarizing {compacting.count} message{compacting.count === 1 ? "" : "s"}… Chat is paused until it finishes.</span>
        </TopBanner>
      )}
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
        beforeMessages={
          summary ? (
            <SessionSummaryBlock
              // Remount per compaction so a re-compact discards any stale open
              // editor draft instead of letting it clobber the merged summary.
              key={summaryCreatedAt ?? 0}
              summary={summary}
              summarizedCount={summaryUpTo}
              createdAt={summaryCreatedAt}
              showOriginals={showOriginals}
              onToggleOriginals={() => setShowOriginals((s) => !s)}
              onSave={handleSummarySave}
              onDelete={handleSummaryDelete}
              readOnly={isCompacting}
            />
          ) : undefined
        }
        collapseCount={summary && !showOriginals && summaryUpTo ? summaryUpTo : undefined}
        analysisOnlyIndex={summary && !showOriginals && summaryUpTo ? summaryUpTo : undefined}
        inputDisabled={isCompacting}
        onRetryTruncate={truncateTo}
        emptyStateExtras={emptyStateNotifiers}
        onBeforeStop={handleBeforeStop}
        onStatusChange={(status, msgs) => {
          const loading = status === "submitted" || status === "streaming";
          setIsStreaming(loading);
          if (loading) {
            hasMarkedViewed.current = false;
            setSelectingCompact(false);
          }
          if (msgs.length > 0) setHasMessages(true);
          setHasBoundary(hasCompactBoundary(msgs));
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
          needsRetry && !isCompacting ? (
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

/**
 * Whether message `index` can be a compaction boundary: any assistant message
 * works, except an analysis at index 0, which has nothing earlier to summarize
 * (compactionUpTo returns null there). Single source of truth for the
 * per-message picker button and the "is there any boundary" check.
 */
function canCompactAt(msg: UIMessage, index: number): boolean {
  return msg.role === "assistant" && (!isAnalysisMessage(msg) || index >= 1);
}

function hasCompactBoundary(msgs: UIMessage[]): boolean {
  return msgs.some(canCompactAt);
}

const BANNER_TONES = {
  error: "text-[#b33a2a] bg-[#b33a2a]/5 border-[#b33a2a]/20",
  compaction: "text-[#8a6d3b] bg-[#f5f1e6] border-[#8a6d3b]/25",
} as const;

/** Floating top-center notification banner shared by the drop/compaction flows. */
function TopBanner({ tone, children }: { tone: keyof typeof BANNER_TONES; children: React.ReactNode }) {
  return (
    <div className={`absolute top-2 left-1/2 -translate-x-1/2 z-40 text-sm border rounded px-4 py-2 flex items-center gap-3 shadow-sm font-sans ${BANNER_TONES[tone]}`}>
      {children}
    </div>
  );
}

function CompactionSpinner() {
  return (
    <svg className="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

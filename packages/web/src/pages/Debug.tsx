import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { UIMessage } from "ai";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_SESSION_TITLE, SESSION_KIND, UNIFIED_SCOPE, compactionUpTo, isAnalysisMessage } from "@tracer-sh/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "../lib/trpc";
import { useParsedMessages } from "../lib/chat-utils";
import { useDeleteSession, usePersistedState } from "../lib/hooks";
import { sessionKindLabel } from "../lib/session-kind";
import { formatTime } from "../lib/format";
import type { ProgressStore } from "../lib/progress-store";
import { LiveStreamView } from "../components/chat/LiveStreamView";
import { ChatCore, type ChatCoreRef, type RenderView } from "../components/chat/ChatCore";
import { COLUMN } from "../components/chat/Transcript";
import { POST_MORTEM_PROMPT, monitorNameOf, textOf, transcriptOf } from "../components/chat/MessageView";
import { MessageActionButton, copyText } from "../components/chat/MessageActions";
import { SessionSummaryBlock } from "../components/chat/SessionSummaryBlock";
import { SourcesToggle } from "../components/chat/SourcesToggle";
import { SessionHeader } from "../components/debug/SessionHeader";
import { CostDisplay, computeCostBreakdown } from "../components/debug/CostDisplay";
import { EditMessageForm } from "../components/debug/EditMessageForm";
import { NewInvestigation } from "../components/debug/NewInvestigation";
import { ConfirmDialog } from "../components/common/ConfirmDialog";

const PROVIDER_KEY = "tracer:activeProvider";

function sessionMeta(kind: string | null | undefined, messages: UIMessage[], at: number | undefined): string[] {
  return [
    sessionKindLabel(kind),
    kind === SESSION_KIND.MONITOR ? monitorNameOf(messages) : undefined,
    at ? formatTime(at) : undefined,
  ].filter((s): s is string => !!s);
}

function CompactBanner({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn(COLUMN, "pb-3")}>
      <div role="status" className="flex items-center gap-3 rounded-lg bg-primary-tint px-4 py-2.5 text-sm text-ink-2 animate-in fade-in duration-200">
        {children}
        {action}
      </div>
    </div>
  );
}

export function Debug({ sessionId, isNew, onDeleted }: { sessionId: string; isNew: boolean; onDeleted: () => void }) {
  // Everyone starts in the cross-provider unified scope; picking a provider is remembered across sessions.
  const [activeProvider, setActiveProvider] = usePersistedState<string>(PROVIDER_KEY, UNIFIED_SCOPE);

  const utils = trpc.useUtils();
  const markViewed = trpc.sessions.markViewed.useMutation();
  const deleteSessionById = useDeleteSession({ onDeleted });
  const deleteSession = () => deleteSessionById(sessionId);

  const sessionQuery = trpc.sessions.get.useQuery({ id: sessionId }, { gcTime: 0, enabled: !isNew });

  // Mark the open session viewed whenever the list shows it unread (on select, or when a run finishes here).
  const listStatus = trpc.sessions.list.useQuery(undefined, { select: (l) => l.find((s) => s.id === sessionId)?.status }).data;
  useEffect(() => {
    if (!listStatus || listStatus === "idle" || listStatus === "streaming") return;
    utils.sessions.list.setData(undefined, (prev) => prev?.map((s) => (s.id === sessionId ? { ...s, status: "idle" } : s)));
    markViewed.mutate({ id: sessionId });
  }, [sessionId, listStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const initialMessages = useParsedMessages(sessionQuery.data?.messagesJson);

  // Separate from sessions.get so refreshing cost after a stream never unmounts the chat.
  const costQuery = trpc.sessions.getCost.useQuery({ id: sessionId });
  const costBreakdown = useMemo(() => {
    const d = costQuery.data;
    if (!d?.agents?.length) return null;
    const updatedAt = sessionQuery.data?.updatedAt;
    return computeCostBreakdown(d.agents, updatedAt ? updatedAt * 1000 : undefined);
  }, [costQuery.data, sessionQuery.data?.updatedAt]);
  const cost = costBreakdown && (costBreakdown.totalInput > 0 || costBreakdown.totalOutput > 0) ? <CostDisplay breakdown={costBreakdown} /> : null;
  const sources = <SourcesToggle activeProvider={activeProvider} onToggle={setActiveProvider} />;

  let body: React.ReactNode;
  if (sessionQuery.isLoading) {
    body = (
      <div role="status" aria-label="Loading investigation" className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (sessionQuery.data?.status === "streaming") {
    // A compacted session hides its summarized messages here too (display-only).
    const live = sessionQuery.data;
    const liveMsgs = initialMessages ?? [];
    const liveUpTo = live.summary && live.summaryUpTo && live.summaryUpTo <= liveMsgs.length ? live.summaryUpTo : 0;
    body = (
      <LiveStreamView
        key={sessionId}
        sessionId={sessionId}
        initialMessages={liveMsgs}
        collapseCount={liveUpTo}
        analysisOnlyIndex={liveUpTo > 0 ? liveUpTo : undefined}
        onComplete={() => sessionQuery.refetch()}
        header={
          <SessionHeader
            chatId={sessionId}
            title={live.title === DEFAULT_SESSION_TITLE ? undefined : live.title}
            meta={sessionMeta(live.kind, liveMsgs, live.updatedAt)}
            streaming
            onPostMortem={() => {}}
            onCopyText={() => copyText(transcriptOf(live.title, liveMsgs), "Copied as text")}
            onDelete={deleteSession}
          />
        }
        beforeMessages={
          liveUpTo > 0 && live.summary ? (
            <SessionSummaryBlock summary={live.summary} summarizedCount={liveUpTo} createdAt={live.summaryCreatedAt} readOnly />
          ) : undefined
        }
        sources={sources}
        cost={cost}
      />
    );
  } else if (sessionQuery.data?.kind === SESSION_KIND.IMPORTED) {
    body = (
      <ImportedView
        key={sessionId}
        sessionId={sessionId}
        sessionTitle={sessionQuery.data.title}
        initialMessages={initialMessages ?? []}
        onDelete={deleteSession}
      />
    );
  } else {
    body = (
      <DebugChat
        key={sessionId}
        chatId={sessionId}
        initialMessages={initialMessages}
        sources={sources}
        cost={cost}
        activeProvider={activeProvider}
        sessionTitle={sessionQuery.data?.title}
        sessionKind={sessionQuery.data?.kind}
        sessionUpdatedAt={sessionQuery.data?.updatedAt}
        summary={sessionQuery.data?.summary}
        summaryUpTo={sessionQuery.data?.summaryUpTo}
        summaryCreatedAt={sessionQuery.data?.summaryCreatedAt}
        onDelete={deleteSession}
      />
    );
  }

  return <div className="relative h-full">{body}</div>;
}

interface ImportedViewProps {
  sessionId: string;
  sessionTitle: string;
  initialMessages: UIMessage[];
  onDelete: () => void;
}

function ImportedView({ sessionId, sessionTitle, initialMessages, onDelete }: ImportedViewProps) {
  const first = initialMessages[0] as (UIMessage & { metadata?: { sourceTitle?: string; sourceCreatedAt?: number } }) | undefined;
  const sourceTitle = first?.metadata?.sourceTitle ?? sessionTitle;
  const sourceCreatedAt = first?.metadata?.sourceCreatedAt;
  const date = sourceCreatedAt ? new Date(sourceCreatedAt * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";

  return (
    <ChatCore
      chatId={sessionId}
      apiEndpoint="/api/chat"
      initialMessages={initialMessages}
      readOnly
      readOnlyNotice={
        <p className="rounded-xl border bg-card px-4 py-3 text-center text-[13px]/[18px] text-muted-foreground">
          Imported from an image{date ? ` of ${date}` : ""}. Read-only.
        </p>
      }
      sourceTitle={sourceTitle}
      sourceCreatedAt={sourceCreatedAt}
      scrollHeader={
        <SessionHeader
          chatId={sessionId}
          title={sourceTitle}
          meta={["Imported", ...(date ? [`originally ${date}`] : [])]}
          readOnly
          onCopyText={() => copyText(transcriptOf(sourceTitle, initialMessages), "Copied as text")}
          onDelete={onDelete}
        />
      }
    />
  );
}

interface DebugChatProps {
  chatId: string;
  initialMessages?: UIMessage[];
  sources: React.ReactNode;
  cost: React.ReactNode;
  activeProvider: string | null;
  sessionTitle?: string;
  sessionKind?: string | null;
  sessionUpdatedAt?: number;
  summary?: string | null;
  summaryUpTo?: number | null;
  summaryCreatedAt?: number | null;
  onDelete: () => void;
}

function DebugChat({ chatId, initialMessages, sources, cost, activeProvider, sessionTitle, sessionKind, sessionUpdatedAt, summary, summaryUpTo, summaryCreatedAt, onDelete }: DebugChatProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasMessages, setHasMessages] = useState(!!initialMessages?.length);
  // Compaction needs a boundary to pick; without one, selection mode would be a dead end.
  const [hasBoundary, setHasBoundary] = useState(() => hasCompactBoundary(initialMessages ?? []));
  const [showOriginals, setShowOriginals] = useState(false);
  // Compacting is two steps: the header's Compact enters selection mode, then the user picks the boundary.
  const [selectingCompact, setSelectingCompact] = useState(false);
  // `upTo` ends the hidden range (exclusive); `count` can exceed it since a kept analysis boundary is summarized too.
  const [compacting, setCompacting] = useState<{ upTo: number; count: number } | null>(null);
  const isCompacting = compacting !== null;
  const coreRef = useRef<ChatCoreRef>(null);
  const hasMarkedViewed = useRef(false);
  const utils = trpc.useUtils();
  const [startedAt] = useState(() => Math.floor(Date.now() / 1000));

  // A run the server starts here (follow-up timer, API) flips the page to the live stream view.
  const listStatus = trpc.sessions.list.useQuery(undefined, { select: (l) => l.find((s) => s.id === chatId)?.status }).data;
  const prevListStatus = useRef(listStatus);
  useEffect(() => {
    const started = listStatus === "streaming" && prevListStatus.current !== "streaming";
    prevListStatus.current = listStatus;
    if (started && !isStreaming) utils.sessions.get.fetch({ id: chatId }, { staleTime: 0 }).catch(() => {});
  }, [listStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const markViewed = trpc.sessions.markViewed.useMutation();
  const truncateMessages = trpc.sessions.truncateMessages.useMutation();
  const saveMessages = trpc.sessions.saveMessages.useMutation();
  const compactMutation = trpc.sessions.compact.useMutation();
  const updateSummaryMutation = trpc.sessions.updateSummary.useMutation();
  const clearSummaryMutation = trpc.sessions.clearSummary.useMutation();

  // Drop the summary from the cache (mirrors a server-side clear, e.g. a truncation into the summarized prefix).
  const clearSummaryCache = () => {
    utils.sessions.get.setData({ id: chatId }, (prev) => (prev ? { ...prev, summary: null, summaryUpTo: null, summaryCreatedAt: null } : prev));
    setShowOriginals(false);
  };

  // Truncate the persisted history in lockstep with the client list; the server says whether the summary was invalidated.
  const truncateTo = async (keepCount: number) => {
    const res = await truncateMessages.mutateAsync({ id: chatId, keepCount });
    if (res.summaryCleared) clearSummaryCache();
  };

  const titleQuery = trpc.sessions.getTitle.useQuery({ id: chatId }, { enabled: hasMessages });
  const titlePending = titleQuery.data?.titlePending ?? true;
  const liveTitle = titleQuery.data?.title ?? sessionTitle;
  const headerTitle = !titlePending ? titleQuery.data?.title : sessionTitle && sessionTitle !== DEFAULT_SESSION_TITLE ? sessionTitle : undefined;

  const refreshCostData = useCallback(() => {
    utils.sessions.getCost.invalidate({ id: chatId });
  }, [utils, chatId]);

  // Title generation is billed after the reply; refresh the cost once the title lands.
  const prevTitlePending = useRef(titlePending);
  useEffect(() => {
    if (prevTitlePending.current && !titlePending) refreshCostData();
    prevTitlePending.current = titlePending;
  }, [titlePending, refreshCostData]);

  const resolveSourceTitle = useCallback(async () => {
    const fresh = await utils.sessions.getTitle.fetch({ id: chatId }, { staleTime: 0 });
    return fresh?.title;
  }, [utils, chatId]);

  const handlePostMortem = () => {
    if (!coreRef.current) return;
    coreRef.current.scrollToBottom({ animation: "instant" });
    coreRef.current.sendMessage({ text: POST_MORTEM_PROMPT });
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget === null || !coreRef.current) return;
    try {
      await truncateTo(deleteTarget);
    } catch {
      toast.error("Couldn't delete the messages");
      return;
    }
    const kept = coreRef.current.messages.slice(0, deleteTarget);
    coreRef.current.setMessages(kept);
    setHasBoundary(hasCompactBoundary(kept));
    setDeleteTarget(null);
  };

  const handleStartEdit = (index: number) => {
    const msg = coreRef.current?.messages[index];
    const text = msg ? textOf(msg) : "";
    if (!text) return;
    setEditingIndex(index);
    setEditText(text);
  };

  const handleEditSubmit = async (text: string) => {
    if (editingIndex === null || !text.trim() || !coreRef.current || isCompacting) return;
    const trimmed = text.trim();
    try {
      await truncateTo(editingIndex);
    } catch {
      toast.error("Couldn't edit the message");
      return;
    }
    coreRef.current.setMessages(coreRef.current.messages.slice(0, editingIndex));
    setEditingIndex(null);
    coreRef.current.scrollToBottom({ animation: "instant" });
    coreRef.current.sendMessage({ text: trimmed });
  };

  // Bake in-memory sub-agent progress into tool parts before saving, so partial results survive a refresh.
  const handleBeforeStop = ({ messages: msgs, progressStore }: { messages: UIMessage[]; progressStore: ProgressStore }) => {
    const enrichedMessages = msgs.map((msg) => {
      if (msg.role !== "assistant") return msg;
      const parts = msg.parts.map((part) => {
        const p = part as Record<string, unknown>;
        if (p.toolCallId && p.state !== "output-available") {
          const progress = progressStore.getSnapshot(p.toolCallId as string);
          return { ...p, state: "output-available", output: progress?.parts?.length ? { parts: progress.parts } : { error: "Aborted" } };
        }
        return part;
      });
      return { ...msg, parts };
    });
    saveMessages.mutate({ id: chatId, messages: enrichedMessages });
  };

  const handleCompact = async (index: number) => {
    const upTo = compactionUpTo(coreRef.current?.messages ?? [], index);
    if (upTo === null) {
      toast.error("There are no messages to summarize before the analysis");
      return;
    }
    setSelectingCompact(false);
    setEditingIndex(null); // an open edit form must not truncate or send mid-compaction
    // An existing summary with an earlier boundary already covers its prefix; only the delta is summarized.
    const prior = summary && summaryUpTo != null && summaryUpTo < upTo ? summaryUpTo : 0;
    setCompacting({ upTo, count: index + 1 - prior });
    try {
      const result = await compactMutation.mutateAsync({ id: chatId, upToIndex: index });
      if (utils.sessions.get.getData({ id: chatId })) {
        utils.sessions.get.setData({ id: chatId }, (prev) => (prev ? { ...prev, ...result } : prev));
      } else {
        // New chat: the query is disabled and uncached, so invalidate() would not refetch.
        await utils.sessions.get.fetch({ id: chatId }, { staleTime: 0 }).catch(() => {});
      }
      utils.sessions.getCost.invalidate({ id: chatId });
      setShowOriginals(false);
    } catch (err) {
      toast.error("Couldn't summarize the conversation", { description: err instanceof Error ? err.message : undefined });
      // The server may still have committed (e.g. the response was lost), so re-sync.
      utils.sessions.get.fetch({ id: chatId }, { staleTime: 0 }).catch(() => {});
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
        onError: (err) => toast.error("Couldn't delete the summary", { description: err.message }),
      },
    );
  };

  useEffect(() => {
    if (!selectingCompact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectingCompact(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectingCompact]);

  // Stable refs so renderMessage isn't re-created during streaming.
  const handleStartEditRef = useRef(handleStartEdit);
  handleStartEditRef.current = handleStartEdit;
  const handleCompactRef = useRef(handleCompact);
  handleCompactRef.current = handleCompact;
  const handleEditSubmitRef = useRef(handleEditSubmit);
  handleEditSubmitRef.current = handleEditSubmit;

  const renderMessage = useCallback(
    (msg: UIMessage, index: number, view: RenderView) => {
      // Actions are hidden during streaming, editing and compaction: a truncate racing those would corrupt indices.
      const idle = !isStreaming && editingIndex === null && !selectingCompact && compacting === null;
      let footer: React.ReactNode = null;
      if (compacting?.upTo === index + 1) {
        footer = (
          <span role="status" className="inline-flex items-center gap-2 rounded-md bg-primary-tint px-2.5 py-1 text-xs text-primary">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Summarizing up to here
          </span>
        );
      } else if (selectingCompact && compacting === null && canCompactAt(msg, index)) {
        footer = (
          <Button variant="outline" size="xs" onClick={() => handleCompactRef.current(index)}>
            Summarize up to here
          </Button>
        );
      }
      return view({
        showActions: idle,
        actions: idle && (
          <>
            {msg.role === "user" && <MessageActionButton icon={<Pencil />} label="Edit" onClick={() => handleStartEditRef.current(index)} />}
            <MessageActionButton icon={<Trash2 />} label="Delete from here" onClick={() => setDeleteTarget(index)} />
          </>
        ),
        body:
          editingIndex === index ? (
            <EditMessageForm initialText={editText} onSave={(text) => handleEditSubmitRef.current(text)} onCancel={() => setEditingIndex(null)} />
          ) : undefined,
        // Messages the running summary will hide fade out.
        dimmed: compacting !== null && index < compacting.upTo,
        footer,
      });
    },
    // editText omitted: it only changes in the same batch as editingIndex.
    [isStreaming, editingIndex, compacting, selectingCompact], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const header = (
    <SessionHeader
      chatId={chatId}
      title={headerTitle}
      meta={sessionMeta(sessionKind, initialMessages ?? [], sessionUpdatedAt ?? startedAt)}
      streaming={isStreaming}
      // Post-mortem sends directly, bypassing the disabled composer, so it is blocked mid-compaction too.
      busy={isStreaming || isCompacting}
      onPostMortem={handlePostMortem}
      onCompact={hasBoundary ? () => setSelectingCompact(true) : undefined}
      onCopyText={() => copyText(transcriptOf(liveTitle ?? "", coreRef.current?.messages ?? []), "Copied as text")}
      onDelete={onDelete}
      onTitleClick={() => coreRef.current?.scrollToTop({ animation: "smooth" })}
      onCostDataReady={refreshCostData}
    >
      {selectingCompact && (
        <CompactBanner action={<Button variant="ghost" size="sm" onClick={() => setSelectingCompact(false)}>Cancel</Button>}>
          <p className="flex-1">Pick a reply. It and everything above it get summarized. Analyses are kept.</p>
        </CompactBanner>
      )}
      {compacting !== null && (
        <CompactBanner>
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <p className="flex-1">
            Summarizing {compacting.count} {compacting.count === 1 ? "message" : "messages"}. The chat is paused until it finishes.
          </p>
        </CompactBanner>
      )}
    </SessionHeader>
  );

  return (
    <>
      <ChatCore
        ref={coreRef}
        chatId={chatId}
        apiEndpoint="/api/chat"
        placeholder={hasMessages ? "Ask a follow-up" : "Describe the problem, paste an error, or drop a screenshot"}
        initialMessages={initialMessages}
        sourceTitle={liveTitle}
        sourceCreatedAt={sessionUpdatedAt}
        resolveSourceTitle={resolveSourceTitle}
        scrollHeader={header}
        emptyState={(composer) => <NewInvestigation composer={composer} />}
        beforeMessages={
          summary ? (
            <SessionSummaryBlock
              // Remount per compaction so a stale open editor draft can't clobber the merged summary.
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
          if (status === "submitted") {
            utils.sessions.list.setData(undefined, (prev) => {
              if (!prev || prev.some((s) => s.id === chatId)) return prev;
              return [{ id: chatId, title: DEFAULT_SESSION_TITLE, status: "streaming", kind: null, updatedAt: Math.floor(Date.now() / 1000), titlePending: true }, ...prev];
            });
          }
          if (status === "ready") {
            if (!hasMarkedViewed.current) {
              hasMarkedViewed.current = true;
              markViewed.mutate({ id: chatId });
            }
            refreshCostData();
          }
        }}
        extraBody={activeProvider ? { activeProvider } : undefined}
        sources={sources}
        cost={cost}
        renderMessage={renderMessage}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete from here?"
        description="This message and everything after it are removed. This cannot be undone."
        actionLabel="Delete"
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}

/** An assistant message can be a compaction boundary, except an analysis at index 0, which has nothing earlier to summarize. */
function canCompactAt(msg: UIMessage, index: number): boolean {
  return msg.role === "assistant" && (!isAnalysisMessage(msg) || index >= 1);
}

function hasCompactBoundary(msgs: UIMessage[]): boolean {
  return msgs.some(canCompactAt);
}

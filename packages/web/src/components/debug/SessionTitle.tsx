import { useState, useRef, useEffect } from "react";
import { usePolling, useClickOutside } from "../../lib/hooks";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";

const MEMORY_OP_LABELS: Record<string, { icon: string; verb: string }> = {
  create: { icon: "+", verb: "Saved" },
  update: { icon: "~", verb: "Updated" },
  delete: { icon: "-", verb: "Deleted" },
};

function MemoryBadge({ sessionId, streaming, onCostDataReady }: { sessionId: string; streaming: boolean; onCostDataReady?: () => void }) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();
  const memOps = trpc.memory.bySession.useQuery({ sessionId });
  const allOps = memOps.data;

  // "completed" row = memory agent finished; use started/completed counts to handle concurrent agents
  const { startedCount, completedCount } = allOps?.reduce(
    (acc, op) => {
      if (op.operation === "started") acc.startedCount++;
      else if (op.operation === "completed") acc.completedCount++;
      return acc;
    },
    { startedCount: 0, completedCount: 0 },
  ) ?? { startedCount: 0, completedCount: 0 };
  const agentDone = startedCount > 0 && startedCount === completedCount;
  const displayOps = allOps?.filter((op) => op.operation !== "completed" && op.operation !== "started") ?? [];

  // Timeout after 30s to avoid polling forever when no memory agent runs
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (streaming) {
      setTimedOut(false); // reset on new stream
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), 30_000);
    return () => clearTimeout(timer);
  }, [streaming]);

  // Re-fetch memory ops once when streaming ends — picks up "started" marker
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      utils.memory.bySession.invalidate({ sessionId });
    }
    prevStreaming.current = streaming;
  }, [streaming, sessionId, utils]);

  // Notify parent when memory agents complete (for cost data refresh)
  const prevAgentDone = useRef(false);
  useEffect(() => {
    if (!prevAgentDone.current && agentDone) {
      onCostDataReady?.();
    }
    prevAgentDone.current = agentDone;
  }, [agentDone, onCostDataReady]);

  // Poll after streaming ends, until the memory agent marks "completed"
  const shouldPoll = !streaming && !agentDone && !timedOut && memOps.status === "success" && (allOps?.length ?? 0) > 0;
  usePolling(() => utils.memory.bySession.invalidate({ sessionId }), 3_000, shouldPoll);

  useClickOutside(popoverRef, () => setOpen(false));

  const showTimeoutHint = timedOut && !agentDone;

  if (!displayOps.length) return null;

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 text-xs font-sans transition-colors ${showTimeoutHint ? "text-[#b0a89f] hover:text-[#9c9890]" : "text-[#666666] hover:text-[#2b5ea7]"}`}
        title={showTimeoutHint ? "Memory agent did not respond" : undefined}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
          <line x1="9" y1="21" x2="15" y2="21"/>
          <line x1="10" y1="24" x2="14" y2="24"/>
        </svg>
        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-[#2b5ea7]/10 text-[#2b5ea7] text-[10px] font-medium">
          {displayOps.length}
        </span>
      </button>
      {open && (
        <div className={`right-0 top-full mt-1 ${theme.popoverWide}`}>
          <div className={theme.popoverLabel}>Memory Log</div>
          {displayOps.map((op) => {
            const label = MEMORY_OP_LABELS[op.operation] ?? { icon: "?", verb: op.operation };
            return (
              <div key={op.id} className={theme.popoverRow}>
                <span className="shrink-0 w-4 h-4 rounded text-center leading-4 font-mono text-[10px] bg-[#e8e3da]/30">
                  {label.icon}
                </span>
                <span>
                  <span className="font-medium">{label.verb}</span>
                  {op.note && <span className="opacity-80">: {op.note}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Isolated title component — owns the sessions.list subscription so title polls
 *  don't cascade re-renders to the entire message list. */
export function SessionTitle({ chatId, hasMessages, isLoading, onPostMortem, streaming, onCostDataReady, onTitleClick }: {
  chatId: string;
  hasMessages: boolean;
  isLoading: boolean;
  onPostMortem: () => void;
  streaming?: boolean;
  onCostDataReady?: () => void;
  onTitleClick?: () => void;
}) {
  const titleQuery = trpc.sessions.getTitle.useQuery({ id: chatId });
  const sessionTitle = titleQuery.data?.title;
  const titlePending = titleQuery.data?.titlePending ?? true; // unknown session = title pending
  const utils = trpc.useUtils();

  const needsTitlePoll = hasMessages && titlePending;

  // Timeout after 60s to avoid polling forever if title never resolves
  const [titleTimedOut, setTitleTimedOut] = useState(false);
  useEffect(() => {
    if (!needsTitlePoll) { setTitleTimedOut(false); return; }
    const timer = setTimeout(() => setTitleTimedOut(true), 60_000);
    return () => clearTimeout(timer);
  }, [needsTitlePoll]);

  usePolling(() => utils.sessions.getTitle.invalidate({ id: chatId }), 5_000, needsTitlePoll && !titleTimedOut);

  // Notify parent when title resolves (for cost data refresh)
  const prevTitlePending = useRef(titlePending);
  useEffect(() => {
    if (prevTitlePending.current && !titlePending) {
      onCostDataReady?.();
    }
    prevTitlePending.current = titlePending;
  }, [titlePending, onCostDataReady]);

  return (
    <div className={theme.titleBar}>
      <div className="flex items-center justify-between">
        {(() => {
          const resolved = !titlePending && sessionTitle;
          const baseClass = `${theme.titleText} transition-opacity duration-500 ${resolved ? "opacity-100" : "opacity-0"}`;
          const content = resolved ? sessionTitle : "\u00A0";
          return onTitleClick ? (
            <button
              type="button"
              onClick={onTitleClick}
              title="Scroll to top"
              className={`${baseClass} text-left hover:opacity-80 cursor-pointer`}
            >
              {content}
            </button>
          ) : (
            <h2 className={baseClass}>{content}</h2>
          );
        })()}
        <div className="flex items-center gap-3">
          {hasMessages && <MemoryBadge sessionId={chatId} streaming={streaming ?? false} onCostDataReady={onCostDataReady} />}
          {streaming ? (
            <div className="flex items-center gap-1.5 text-xs text-[#9c9890] font-sans">
              <span className={theme.streamingDot} />
              Streaming
            </div>
          ) : hasMessages && !isLoading && (
            <button
              type="button"
              onClick={onPostMortem}
              className={`flex items-center gap-1.5 ${theme.metaLink}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              Post-Mortem
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

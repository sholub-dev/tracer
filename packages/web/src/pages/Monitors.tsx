import { useCallback, useRef, useState } from "react";
import { SESSION_PREFIX } from "@tracer-sh/shared";
import { usePolling } from "../lib/hooks";
import { theme } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { MonitorChatPanel } from "../components/monitors/MonitorChatPanel";
import { MonitorCard } from "../components/monitors/MonitorCard";
import { TimeRangePicker } from "../components/ui/TimeRangePicker";

interface MonitorsProps {
  builderSessionId?: string;
  onNavigate: (sessionId: string) => void;
  onOpenBuilder: (sessionId: string) => void;
  onCloseBuilder: () => void;
}

type Editing = { sessionId: string; prefill: string };

const newBuilderId = () => `${SESSION_PREFIX.MONITORS}${crypto.randomUUID()}`;
const LIST_POLL_MS = 30_000;
const RANGE_PRESETS = [
  { label: "24h", since: "24 hours ago" },
  { label: "7d", since: "7 days ago" },
  { label: "30d", since: "30 days ago" },
  { label: "90d", since: "90 days ago" },
] as const;

type CardWidth = 50 | 75 | 100;
const WIDTHS: CardWidth[] = [50, 75, 100];
// Container breakpoints: the grid narrows when the builder chat is open.
const SPAN_CLASS: Record<CardWidth, string> = { 50: "@4xl:col-span-2", 75: "@4xl:col-span-3", 100: "@4xl:col-span-4" };
const toWidth = (w: number | null | undefined): CardWidth => (w === 75 || w === 100 ? w : 50);

export function Monitors({ builderSessionId, onNavigate: navigate, onOpenBuilder, onCloseBuilder }: MonitorsProps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [since, setSince] = useState<string>("24 hours ago");
  const utils = trpc.useUtils();
  const listQuery = trpc.monitors.list.useQuery();
  const monitors = listQuery.data ?? [];

  usePolling(() => utils.monitors.list.invalidate(), LIST_POLL_MS, true, false);

  const hasMonitors = monitors.length > 0;

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<{ id: string; width: CardWidth } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const reorder = trpc.monitors.reorder.useMutation({ onError: () => utils.monitors.list.invalidate() });
  const setCardWidth = trpc.monitors.setCardWidth.useMutation({ onError: () => utils.monitors.list.invalidate() });

  // Latest values for the stable card handlers below, so a drag or resize re-renders only affected cards.
  const live = useRef({ monitors, dragId, overId, utils, reorder: reorder.mutate, setCardWidth: setCardWidth.mutate });
  live.current = { ...live.current, monitors, utils, reorder: reorder.mutate, setCardWidth: setCardWidth.mutate };

  const onDragStartId = useCallback((id: string) => {
    live.current.dragId = id;
    setDragId(id);
  }, []);
  const onDragEnd = useCallback(() => {
    live.current.dragId = null;
    live.current.overId = null;
    setDragId(null);
    setOverId(null);
  }, []);
  const onOverId = useCallback((id: string) => {
    if (!live.current.dragId || live.current.overId === id) return;
    live.current.overId = id;
    setOverId(id);
  }, []);
  const onDropId = useCallback((targetId: string) => {
    const { dragId: from, monitors: rows, utils: u } = live.current;
    onDragEnd();
    if (!from || from === targetId) return;
    const ids = rows.map((m) => m.id).filter((id) => id !== from);
    ids.splice(rows.findIndex((m) => m.id === targetId), 0, from);
    const byId = new Map(rows.map((m) => [m.id, m]));
    u.monitors.list.setData(undefined, ids.map((id) => byId.get(id)!));
    live.current.reorder({ ids });
  }, [onDragEnd]);

  const onResizeStart = useCallback((id: string, e: React.PointerEvent) => {
    const grid = gridRef.current;
    const card = document.getElementById(`monitor-${id}`);
    if (!grid || !card || e.button !== 0) return;
    e.preventDefault();
    const style = getComputedStyle(grid);
    const inner = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const left = card.getBoundingClientRect().left;
    const start = toWidth(live.current.monitors.find((m) => m.id === id)?.cardWidth);
    let current = start;
    setResizing({ id, width: start });
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const pct = ((ev.clientX - left) / inner) * 100;
      const next = WIDTHS.reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a));
      if (next !== current) {
        current = next;
        setResizing({ id, width: next });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(null);
      if (current === start) return;
      live.current.utils.monitors.list.setData(undefined, (rows) => rows?.map((m) => (m.id === id ? { ...m, cardWidth: current } : m)));
      live.current.setCardWidth({ id, width: current });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const onEdit = useCallback((id: string) => {
    const m = live.current.monitors.find((row) => row.id === id);
    const newId = newBuilderId();
    setEditing({ sessionId: newId, prefill: m ? `Modify monitor "${m.name}": ` : "" });
    onOpenBuilder(newId);
  }, [onOpenBuilder]);

  const startNew = () => onOpenBuilder(newBuilderId());

  let overlay;
  if (listQuery.isSuccess && !hasMonitors) {
    overlay = (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-sm text-[#666666] font-sans">No monitors yet. Describe what to watch and the agent builds it.</p>
          <button type="button" onClick={startNew} className={theme.primaryBtn}>New monitor</button>
        </div>
      </div>
    );
  }

  const grid = hasMonitors && (
    <div className="@container flex-1 min-h-0 overflow-y-auto">
      <div ref={gridRef} className="p-6 grid grid-cols-1 @4xl:grid-cols-4 gap-4 items-stretch content-start">
        {monitors.map((m) => (
          <MonitorCard
            key={m.id}
            monitor={m}
            since={since}
            spanClass={SPAN_CLASS[resizing?.id === m.id ? resizing.width : toWidth(m.cardWidth)]}
            isDragging={dragId === m.id}
            isTarget={!!dragId && overId === m.id && dragId !== m.id}
            resizeActive={resizing?.id === m.id}
            onNavigate={navigate}
            onEdit={onEdit}
            onDragStartId={onDragStartId}
            onDragEnd={onDragEnd}
            onOverId={onOverId}
            onDropId={onDropId}
            onResizeStart={onResizeStart}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className={`flex items-center justify-between px-6 py-4 ${theme.header}`}>
        <span className={theme.headerTitle}>Monitors</span>
        <div className="flex items-center gap-4">
          {hasMonitors && <TimeRangePicker value={since} onChange={setSince} presets={RANGE_PRESETS} />}
          {builderSessionId && (
            <button type="button" onClick={onCloseBuilder} className={theme.secondaryBtn}>Close chat</button>
          )}
          <button type="button" onClick={startNew} className={theme.primaryBtn}>Edit</button>
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 bg-[#fafaf8]">{overlay}{grid}</div>
        {builderSessionId && (
          <MonitorChatPanel
            key={builderSessionId}
            sessionId={builderSessionId}
            initialInput={editing?.sessionId === builderSessionId ? editing.prefill : undefined}
          />
        )}
      </div>
    </div>
  );
}

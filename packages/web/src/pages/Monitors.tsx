import { useCallback, useRef, useState } from "react";
import { SESSION_PREFIX } from "@tracer-sh/shared";
import { usePersistedState, usePolling } from "../lib/hooks";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "../lib/trpc";
import { PageSidebarButton } from "../components/layout/Shell";
import { BuilderSheet } from "../components/monitors/BuilderSheet";
import { MonitorCard } from "../components/monitors/MonitorCard";
import { TimeRangePicker } from "../components/common/TimeRangePicker";

interface MonitorsProps {
  builderSessionId?: string;
  onNavigate: (sessionId: string) => void;
  onOpenBuilder: (sessionId: string) => void;
  onCloseBuilder: () => void;
}

type Editing = { sessionId: string; name: string };

const newBuilderId = () => `${SESSION_PREFIX.MONITORS}${crypto.randomUUID()}`;
const LIST_POLL_MS = 30_000;
const RANGE_PRESETS = [
  { label: "1h", since: "1 hour ago" },
  { label: "3h", since: "3 hours ago" },
  { label: "6h", since: "6 hours ago" },
  { label: "24h", since: "24 hours ago" },
  { label: "7d", since: "7 days ago" },
  { label: "30d", since: "30 days ago" },
  { label: "90d", since: "90 days ago" },
] as const;
const DEFAULT_RANGE = "24 hours ago";

type CardWidth = 50 | 75 | 100;
const WIDTHS: CardWidth[] = [50, 75, 100];
const SPAN_CLASS: Record<CardWidth, string> = { 50: "min-[1100px]:col-span-2", 75: "min-[1100px]:col-span-3", 100: "min-[1100px]:col-span-4" };
const toWidth = (w: number | null | undefined): CardWidth => (w === 75 || w === 100 ? w : 50);

export function Monitors({ builderSessionId, onNavigate: navigate, onOpenBuilder, onCloseBuilder }: MonitorsProps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [storedSince, setSince] = usePersistedState<string>("tracer:monitorsSince", DEFAULT_RANGE);
  const since = RANGE_PRESETS.some((p) => p.since === storedSince) ? storedSince : DEFAULT_RANGE;
  const utils = trpc.useUtils();
  // Each visit reloads: the cached list can be from before the app went to the background.
  const listQuery = trpc.monitors.list.useQuery(undefined, { refetchOnMount: "always" });
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
    setEditing(m ? { sessionId: newId, name: m.name } : null);
    onOpenBuilder(newId);
  }, [onOpenBuilder]);

  const startNew = () => onOpenBuilder(newBuilderId());

  const editingName = editing && editing.sessionId === builderSessionId ? editing.name : undefined;
  const firing = monitors.filter((m) => m.enabled && m.lastStatus === "triggered").length;
  const newButton = (
    <Button onClick={startNew}>
      <Plus />
      New monitor
    </Button>
  );

  return (
    <div className="min-h-full bg-background text-foreground">
      <header data-page-header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <PageSidebarButton />
          <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Monitors</h1>
            {listQuery.isSuccess && (
              <p className="text-[13px] leading-[18px] text-muted-foreground tabular-nums">
                {monitors.length} {monitors.length === 1 ? "monitor" : "monitors"} · {firing} firing
              </p>
            )}
          </div>
          {hasMonitors && (
            <TimeRangePicker
              value={since}
              onChange={setSince}
              presets={RANGE_PRESETS}
              className="order-last max-sm:w-full max-sm:[&>*]:flex-1 sm:order-none"
            />
          )}
          {newButton}
        </div>
      </header>

      {listQuery.isPending && (
        <div role="status" aria-label="Loading monitors" className="mx-auto grid max-w-[1400px] gap-4 px-4 py-6 sm:px-6 min-[1100px]:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-48 rounded-xl min-[1100px]:col-span-2" />)}
        </div>
      )}

      {listQuery.isError && !listQuery.data && (
        <div role="alert" className="flex flex-col items-center gap-3 px-4 py-24 text-center">
          <p className="text-sm text-muted-foreground">Couldn't load monitors.</p>
          <Button variant="outline" size="sm" onClick={() => void listQuery.refetch()}>Retry</Button>
        </div>
      )}

      {listQuery.isSuccess && !hasMonitors && (
        <div className="flex flex-col items-center gap-4 px-4 py-24 text-center">
          <p className="text-sm text-muted-foreground">No monitors yet. Describe what to watch and the agent builds it.</p>
          {newButton}
        </div>
      )}

      {hasMonitors && (
        <div
          ref={gridRef}
          className="mx-auto grid max-w-[1400px] items-start gap-4 px-4 py-6 sm:px-6 min-[1100px]:grid-cols-4"
        >
          {monitors.map((m) => (
            <MonitorCard
              key={m.id}
              monitor={m}
              since={since}
              rangeLabel={since.replace(/ ago$/, "")}
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
      )}

      <BuilderSheet
        sessionId={builderSessionId}
        editingName={editingName}
        initialInput={editingName ? `Modify monitor "${editingName}": ` : undefined}
        onOpenChat={onOpenBuilder}
        onClose={onCloseBuilder}
      />
    </div>
  );
}

import { useState, useCallback, useRef, useEffect } from "react";
import { ReactGridLayout, WidthProvider, type Layout } from "react-grid-layout/legacy";
import "react-grid-layout/css/styles.css";
import { Loader2, MessageSquare, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "../lib/trpc";
import { WEB_CONFIG } from "../lib/config";
import { usePersistedState } from "../lib/hooks";
import { WidgetCard } from "../components/dashboard/WidgetCard";
import { DashboardChatPanel } from "../components/dashboard/DashboardChatPanel";
import { DEFAULT_SINCE, TIME_RANGE_PRESETS } from "../lib/nrql-utils";
import { TimeRangePicker } from "../components/common/TimeRangePicker";
import { IconButton } from "../components/common/IconButton";

const GridLayout = WidthProvider(ReactGridLayout);

function EditableTitle({ dashboardId, title }: { dashboardId: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameMutation = trpc.dashboards.rename.useMutation();
  const utils = trpc.useUtils();

  const startEditing = () => {
    setDraft(title);
    setEditing(true);
  };

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) return;
    renameMutation.mutate(
      { id: dashboardId, title: trimmed },
      { onSuccess: () => { utils.dashboards.list.invalidate(); } },
    );
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        aria-label="Dashboard name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-8 w-64 text-base font-semibold"
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
      <IconButton label="Rename dashboard" className="text-muted-foreground" onClick={startEditing}>
        <Pencil />
      </IconButton>
    </div>
  );
}

interface DashboardProps {
  dashboardId: string | null;
  onSelectDashboard: (id: string) => void;
}

export function Dashboard({ dashboardId, onSelectDashboard }: DashboardProps) {
  const dashboardsQuery = trpc.dashboards.list.useQuery();

  // A bare /dashboard opens the first dashboard.
  useEffect(() => {
    if (dashboardId) return;
    const list = dashboardsQuery.data;
    if (list && list.length > 0) {
      onSelectDashboard(list[0].id);
    }
  }, [dashboardId, dashboardsQuery.data, onSelectDashboard]);

  if (!dashboardId || !dashboardsQuery.data) {
    return (
      <div role="status" aria-label="Loading dashboards" className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const currentDashboard = dashboardsQuery.data.find((d) => d.id === dashboardId);

  return (
    <DashboardContent
      key={dashboardId}
      dashboardId={dashboardId}
      title={currentDashboard?.title ?? "New dashboard"}
      initialChatOpen={!currentDashboard}
    />
  );
}

function DashboardContent({ dashboardId, title, initialChatOpen = true }: {
  dashboardId: string; title: string; initialChatOpen?: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  const [storedSince, setSince] = usePersistedState<string>(`tracer:dashboardSince:${dashboardId}`, DEFAULT_SINCE);
  const since = TIME_RANGE_PRESETS.some((p) => p.since === storedSince) ? storedSince : DEFAULT_SINCE;
  const widgetsQuery = trpc.widgets.list.useQuery({ dashboardId });
  const moveMutation = trpc.widgets.move.useMutation();
  const widgets = widgetsQuery.data ?? [];

  // Row height follows the container so the grid always fills the viewport.
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(50);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const compute = () => {
      const h = el.clientHeight;
      if (h > 0) {
        const totalMargin = (WEB_CONFIG.gridRows + 1) * WEB_CONFIG.gridMargin[1];
        const rh = Math.max(Math.floor((h - totalMargin) / WEB_CONFIG.gridRows), WEB_CONFIG.gridMinRowHeight);
        setRowHeight(rh);
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Only persist layout changes the user made; RGL also reports its own compaction passes.
  const isDragging = useRef(false);

  const layout: Layout = widgets.map((w) => ({
    i: w.id,
    x: w.posX,
    y: w.posY,
    w: w.posW,
    h: w.posH,
    minW: 2,
    minH: 2,
  }));

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      if (!isDragging.current) return;
      isDragging.current = false;

      for (const item of newLayout) {
        const widget = widgets.find((w) => w.id === item.i);
        if (!widget) continue;
        if (
          widget.posX !== item.x ||
          widget.posY !== item.y ||
          widget.posW !== item.w ||
          widget.posH !== item.h
        ) {
          moveMutation.mutate({
            id: item.i,
            posX: item.x,
            posY: item.y,
            posW: item.w,
            posH: item.h,
          });
        }
      }
    },
    [widgets, moveMutation],
  );

  return (
    <div className="flex flex-col h-full">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <EditableTitle dashboardId={dashboardId} title={title} />
        </div>
        <TimeRangePicker value={since} onChange={setSince} className="no-scrollbar max-sm:order-last max-sm:w-full max-sm:overflow-x-auto" />
        <Button variant="outline" onClick={() => setChatOpen(!chatOpen)} aria-pressed={chatOpen}>
          <MessageSquare />
          {chatOpen ? "Hide builder" : "Show builder"}
        </Button>
      </header>

      <div className="flex flex-1 min-h-0">
        <div ref={gridRef} className="min-w-0 flex-1 overflow-auto bg-background p-4">
          {widgets.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm font-medium">No widgets yet</p>
              <p className="text-[13px]/[18px] text-muted-foreground">Ask the builder to add one.</p>
            </div>
          ) : (
            <GridLayout
              layout={layout}
              cols={WEB_CONFIG.gridCols}
              rowHeight={rowHeight}
              margin={WEB_CONFIG.gridMargin}
              draggableHandle=".drag-handle"
              draggableCancel="button"
              onDragStart={() => { isDragging.current = true; }}
              onResizeStart={() => { isDragging.current = true; }}
              onLayoutChange={handleLayoutChange}
              compactType="vertical"
              useCSSTransforms
            >
              {widgets.map((widget) => (
                <div key={widget.id}>
                  <WidgetCard widget={widget} since={since} until="NOW" />
                </div>
              ))}
            </GridLayout>
          )}
        </div>

        <DashboardChatPanel dashboardId={dashboardId} className={chatOpen ? "" : "hidden"} />
      </div>
    </div>
  );
}

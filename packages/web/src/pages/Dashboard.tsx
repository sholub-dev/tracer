import { useState, useCallback, useRef, useEffect } from "react";
import { ReactGridLayout, WidthProvider, type Layout } from "react-grid-layout/legacy";
import "react-grid-layout/css/styles.css";
import { theme } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { WidgetCard } from "../components/dashboard/WidgetCard";
import { DashboardChatPanel } from "../components/dashboard/DashboardChatPanel";
import { DEFAULT_SINCE } from "../lib/nrql-utils";
import { TimeRangePicker } from "../components/ui/TimeRangePicker";

const GridLayout = WidthProvider(ReactGridLayout);

/** 12×12 uniform grid — both axes have the same granularity */
const GRID_ROWS = 12;
const GRID_COLS = 12;
const MIN_ROW_HEIGHT = 20;
const GRID_MARGIN: [number, number] = [8, 8];

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
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="text-lg font-semibold text-[#2c2c2c] font-sans bg-transparent border-b border-[#2b5ea7] outline-none px-0 py-0 w-48"
      />
    );
  }

  return (
    <span className="flex items-center gap-2 group">
      <span className={theme.headerTitle}>{title}</span>
      <button type="button" onClick={startEditing} className="text-[#666666] hover:text-[#2b5ea7] text-xs" title="Rename dashboard">
        ✎
      </button>
    </span>
  );
}

interface DashboardProps {
  dashboardId: string | null;
  onSelectDashboard: (id: string) => void;
}

export function Dashboard({ dashboardId, onSelectDashboard }: DashboardProps) {
  const dashboardsQuery = trpc.dashboards.list.useQuery();

  // Auto-redirect: if no dashboardId in URL, navigate to first dashboard
  useEffect(() => {
    if (dashboardId) return;
    const list = dashboardsQuery.data;
    if (list && list.length > 0) {
      onSelectDashboard(list[0].id);
    }
  }, [dashboardId, dashboardsQuery.data, onSelectDashboard]);

  if (!dashboardId || !dashboardsQuery.data) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[#666666] text-sm font-sans">Loading dashboards...</p>
      </div>
    );
  }

  const currentDashboard = dashboardsQuery.data.find((d) => d.id === dashboardId);

  return (
    <DashboardContent
      key={dashboardId}
      dashboardId={dashboardId}
      title={currentDashboard?.title ?? "New Dashboard"}
      initialChatOpen={!currentDashboard}
    />
  );
}

function DashboardContent({ dashboardId, title, initialChatOpen = true }: {
  dashboardId: string; title: string; initialChatOpen?: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  const [since, setSince] = useState(DEFAULT_SINCE);
  const widgetsQuery = trpc.widgets.list.useQuery({ dashboardId });
  const moveMutation = trpc.widgets.move.useMutation();
  const widgets = widgetsQuery.data ?? [];

  // ── Derive rowHeight from container height so the grid is viewport-relative ──
  const gridRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(50); // sensible initial

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const compute = () => {
      const h = el.clientHeight;
      if (h > 0) {
        // Divide visible height into GRID_ROWS equal rows (minus margins)
        const totalMargin = (GRID_ROWS + 1) * GRID_MARGIN[1];
        const rh = Math.max(Math.floor((h - totalMargin) / GRID_ROWS), MIN_ROW_HEIGHT);
        setRowHeight(rh);
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track if user is actively dragging/resizing to avoid flickering
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
      <div className={`flex items-center justify-between px-6 py-4 ${theme.header}`}>
        <EditableTitle dashboardId={dashboardId} title={title} />
        <div className="flex items-center gap-3">
          <TimeRangePicker value={since} onChange={setSince} />
          <button
            type="button"
            onClick={() => setChatOpen(!chatOpen)}
            className={theme.secondaryBtn}
          >
            {chatOpen ? "Hide Chat" : "Show Chat"}
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div ref={gridRef} className={theme.dashboardGrid}>
          {widgets.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-[#666666] text-sm font-sans mb-2">
                  No widgets yet
                </p>
                <p className="text-[#666666] text-xs font-sans">
                  Use the chat to create dashboard widgets
                </p>
              </div>
            </div>
          ) : (
            <GridLayout
              layout={layout}
              cols={GRID_COLS}
              rowHeight={rowHeight}
              margin={GRID_MARGIN}
              draggableHandle=".drag-handle"
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

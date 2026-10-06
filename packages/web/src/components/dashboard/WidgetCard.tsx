import { useState } from "react";
import { RotateCw, Trash2 } from "lucide-react";
import { substituteTimeRange } from "@tracer-sh/shared";
import { QueryChart } from "../charts/QueryChart";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { IconButton } from "../common/IconButton";
import { trpc } from "../../lib/trpc";
import { ErrorBoundary } from "../ErrorBoundary";

interface Widget {
  id: string;
  provider: string;
  title: string;
  query: string;
  chartType: string;
  config: Record<string, unknown>;
  posX: number;
  posY: number;
  posW: number;
  posH: number;
}

export function WidgetCard({ widget, since, until }: { widget: Widget; since: string; until: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const utils = trpc.useUtils();
  const deleteMutation = trpc.widgets.delete.useMutation({
    onSuccess: () => { utils.widgets.list.invalidate(); },
  });

  return (
    <article aria-label={widget.title} className="group flex h-full flex-col overflow-hidden rounded-lg border bg-card">
      <div className="drag-handle flex h-10 shrink-0 cursor-grab items-center justify-between gap-2 border-b pr-1.5 pl-4 active:cursor-grabbing">
        <h2 title={widget.title} className="truncate text-sm font-medium">{widget.title}</h2>
        <div className="flex shrink-0 items-center opacity-100 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">
          <IconButton label="Refresh" size="icon-xs" className="text-muted-foreground" onClick={() => setRefreshKey((k) => k + 1)}>
            <RotateCw />
          </IconButton>
          <IconButton label="Delete widget" size="icon-xs" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
      <ErrorBoundary fallback={(e) => <div role="alert" className="flex h-full items-center justify-center p-4 text-[13px]/[18px] text-destructive">Widget error: {e.message}</div>}>
        <QueryChart
          provider={widget.provider}
          query={substituteTimeRange(widget.query, since, until)}
          refreshKey={refreshKey}
          className="min-h-0 flex-1 overflow-auto p-3"
          chartType={widget.chartType}
        />
      </ErrorBoundary>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${widget.title}"?`}
        description="The widget is removed from this dashboard. This cannot be undone."
        actionLabel="Delete widget"
        onConfirm={() => deleteMutation.mutate({ id: widget.id })}
      />
    </article>
  );
}

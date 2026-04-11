import React, { useState } from "react";
import { theme } from "../../lib/theme";
import { substituteTimeRange } from "@oko/shared";
import { QueryChart } from "../charts/QueryChart";
import { trpc } from "../../lib/trpc";
import { ConfirmDialog } from "../ui/ConfirmDialog";

class WidgetErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="flex items-center justify-center h-full p-4 text-xs text-[#b33a2a]">
          Widget error: {this.state.error}
        </div>
      );
    return this.props.children;
  }
}

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
    <div className={theme.widgetCard}>
      <div className={`${theme.widgetCardHeader} drag-handle`}>
        <span className={theme.widgetCardTitle}>{widget.title}</span>
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setRefreshKey((k) => k + 1);
            }}
            className="text-[#666666] hover:text-[#2b5ea7] text-xs font-sans"
            title="Refresh"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDelete(true);
            }}
            className="text-[#666666] hover:text-[#b33a2a] text-xs font-sans leading-none"
            title="Delete widget"
          >
            ✕
          </button>
        </div>
      </div>
      <WidgetErrorBoundary>
        <QueryChart
          provider={widget.provider}
          query={substituteTimeRange(widget.query, since, until)}
          refreshKey={refreshKey}
          className={theme.widgetCardBody}
          chartType={widget.chartType}
        />
      </WidgetErrorBoundary>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete widget"
        message={`Delete "${widget.title}"?`}
        onConfirm={() => {
          deleteMutation.mutate({ id: widget.id });
          setConfirmDelete(false);
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

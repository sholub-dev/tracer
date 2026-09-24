import { memo, useState } from "react";
import { trpc } from "../../lib/trpc";
import { theme } from "../../lib/theme";
import { formatFrequency, formatTime, statusVariant } from "../../lib/monitor-utils";
import { Badge } from "../ui/Badge";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { MonitorTriggers } from "./MonitorTriggers";

type Utils = ReturnType<typeof trpc.useUtils>;
export type MonitorRow = NonNullable<ReturnType<Utils["monitors"]["list"]["getData"]>>[number];

interface MonitorCardProps {
  monitor: MonitorRow;
  since: string;
  spanClass: string;
  isDragging: boolean;
  isTarget: boolean;
  resizeActive: boolean;
  onNavigate: (monitorId?: string, sessionId?: string) => void;
  onEdit: (id: string) => void;
  onDragStartId: (id: string) => void;
  onDragEnd: () => void;
  onOverId: (id: string) => void;
  onDropId: (id: string) => void;
  onResizeStart: (id: string, e: React.PointerEvent) => void;
}

function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      {[3, 8, 13].flatMap((y) => [2, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}
    </svg>
  );
}

export const MonitorCard = memo(function MonitorCard({
  monitor, since, spanClass, isDragging, isTarget, resizeActive,
  onNavigate, onEdit, onDragStartId, onDragEnd, onOverId, onDropId, onResizeStart,
}: MonitorCardProps) {
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const accent = theme.providerCardAccents[monitor.provider];
  const utils = trpc.useUtils();
  const toggle = trpc.monitors.toggleEnabled.useMutation({ onSuccess: () => utils.monitors.list.invalidate() });
  const setAlert = trpc.monitors.setAlertEnabled.useMutation({ onError: () => utils.monitors.list.invalidate() });
  const toggleAlert = (enabled: boolean) => {
    utils.monitors.list.setData(undefined, (rows) => rows?.map((m) => (m.id === monitor.id ? { ...m, alertEnabled: enabled ? 1 : 0 } : m)));
    setAlert.mutate({ id: monitor.id, enabled });
  };
  const remove = trpc.monitors.delete.useMutation({
    onSuccess: () => {
      utils.monitors.list.invalidate();
      utils.monitors.unreadCount.invalidate();
      onNavigate();
    },
  });

  return (
    <div
      id={`monitor-${monitor.id}`}
      onDragOver={(e) => { e.preventDefault(); onOverId(monitor.id); }}
      onDrop={(e) => { e.preventDefault(); onDropId(monitor.id); }}
      className={`group relative min-w-0 h-full flex flex-col rounded bg-white border font-sans scroll-mt-4 transition-opacity ${accent?.border ?? ""} ${spanClass} ${
        isTarget || resizeActive ? "border-[#d4d2cd] outline-2 outline-dashed outline-offset-2 outline-[#9a9894]" : "border-[#d4d2cd]"
      } ${isDragging ? "opacity-50" : ""}`}
    >
      <div
        onPointerDown={(e) => onResizeStart(monitor.id, e)}
        title="Drag to resize"
        className={`hidden xl:flex absolute inset-y-0 -right-1 w-3 z-10 items-center justify-center cursor-ew-resize transition-opacity ${
          resizeActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <div className="h-10 w-1 rounded-full bg-[#9c9890]" />
      </div>
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <span
            draggable
            title="Drag to reorder"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", monitor.id);
              const card = e.currentTarget.closest<HTMLElement>(`[id="monitor-${monitor.id}"]`);
              if (card) e.dataTransfer.setDragImage(card, 16, 16);
              onDragStartId(monitor.id);
            }}
            onDragEnd={onDragEnd}
            className="shrink-0 -ml-1 px-1 py-0.5 text-[#9c9890] hover:text-[#666666] cursor-grab active:cursor-grabbing"
          >
            <GripIcon />
          </span>
          <span title={monitor.name} className="min-w-0 flex-1 truncate text-base font-semibold text-[#2c2c2c]">{monitor.name}</span>
          <span className="shrink-0">
            <Badge variant={monitor.enabled ? statusVariant(monitor.lastStatus) : "default"}>
              {monitor.enabled ? monitor.lastStatus : "paused"}
            </Badge>
          </span>
          {monitor.unreadCount > 0 && (
            <span
              title={`${monitor.unreadCount} unread`}
              className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-[#2b5ea7] text-white text-[11px] flex items-center justify-center"
            >
              {monitor.unreadCount}
            </span>
          )}
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-[#666666]">
              Run
              <ToggleSwitch
                checked={!!monitor.enabled}
                onChange={(enabled) => toggle.mutate({ id: monitor.id, enabled })}
                title="Run checks on schedule"
                aria-label={monitor.enabled ? "Disable monitor" : "Enable monitor"}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-[#666666]">
              <span className={monitor.enabled ? "" : "opacity-50"}>Alert</span>
              <ToggleSwitch
                checked={!!monitor.alertEnabled}
                onChange={toggleAlert}
                disabled={!monitor.enabled}
                title="Start a debug session when it fires"
                aria-label={monitor.alertEnabled ? "Disable alerts" : "Enable alerts"}
              />
            </label>
            <button type="button" onClick={() => onEdit(monitor.id)} className={theme.outlineBtn}>Edit</button>
            <button
              type="button"
              onClick={() => { remove.reset(); setConfirmDelete(true); }}
              disabled={remove.isPending}
              className="text-xs text-[#666666] hover:text-[#b33a2a] transition-colors"
            >
              Delete
            </button>
          </div>
        </div>

        {remove.error && <div className={theme.errorText}>{remove.error.message}</div>}
        {monitor.lastError && <div className={theme.errorText}>Last error: {monitor.lastError}</div>}

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#666666]">
          <span>Condition: <code className="font-mono font-semibold text-[#444444]">count {monitor.condition}</code></span>
          <span>Runs every <strong className="font-semibold text-[#444444]">{formatFrequency(monitor.frequencySeconds).replace(/^every /, "")}</strong></span>
          <button
            type="button"
            onClick={() => setQueryExpanded((v) => !v)}
            aria-expanded={queryExpanded}
            className="text-[#2b5ea7] hover:text-[#234d8a]"
          >
            Query {queryExpanded ? "∨" : ">"}
          </button>
          <span className="ml-auto">
            {monitor.lastRunAt === null ? "Not run yet" : `Last run ${formatTime(monitor.lastRunAt)}`}
          </span>
        </div>

        {queryExpanded && (
          <pre className="text-[12px] font-mono text-[#444444] bg-[#f5f4f0] border border-[#e8e6e1] rounded px-3 py-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {monitor.query}
            {monitor.chartQuery && `\n\nChart query:\n${monitor.chartQuery}`}
          </pre>
        )}
      </div>

      <MonitorTriggers
        monitorId={monitor.id}
        provider={monitor.provider}
        query={monitor.query}
        chartQuery={monitor.chartQuery}
        lastRunAt={monitor.lastRunAt}
        since={since}
        onNavigate={onNavigate}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete monitor"
        message="Delete this monitor, its trigger history, and its sessions?"
        onConfirm={() => { setConfirmDelete(false); remove.mutate({ id: monitor.id }); }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
});

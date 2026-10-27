import { memo, useState } from "react";
import { AlertTriangle, ChevronDown, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { formatFrequency } from "../../lib/monitor-utils";
import { formatTime } from "../../lib/format";
import { providerLabel } from "../../lib/providers";
import { QueryBlock } from "../chat/ToolParts";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { MoreActionsMenu } from "../common/MoreActionsMenu";
import { ProviderDot } from "../common/ProviderDot";
import { MonitorChart } from "./MonitorChart";
import { MonitorTriggers } from "./MonitorTriggers";

type Utils = ReturnType<typeof trpc.useUtils>;
type MonitorRow = NonNullable<ReturnType<Utils["monitors"]["list"]["getData"]>>[number];
type MonitorState = "active" | "silent" | "paused";

const STATES: { value: MonitorState; label: string; description: string; dot: string }[] = [
  { value: "active", label: "Active", description: "Runs and opens an investigation when it fires", dot: "bg-success" },
  { value: "silent", label: "Silent", description: "Runs and records firings, no investigation", dot: "bg-warning" },
  { value: "paused", label: "Paused", description: "Does not run", dot: "bg-muted-foreground" },
];
const STATE_TOAST: Record<MonitorState, string> = { active: "is active", silent: "runs silently", paused: "is paused" };

const STATUS_BADGE = {
  ok: { label: "OK", className: "bg-success-tint text-success" },
  firing: { label: "Firing", className: "bg-destructive-tint text-destructive" },
  error: { label: "Error", className: "bg-warning-tint text-warning" },
  paused: { label: "Paused", className: "bg-muted text-ink-2" },
};

const stateOf = (m: Pick<MonitorRow, "enabled" | "alertEnabled">): MonitorState =>
  !m.enabled ? "paused" : m.alertEnabled ? "active" : "silent";

function statusOf(m: MonitorRow): keyof typeof STATUS_BADGE {
  if (!m.enabled) return "paused";
  if (m.lastStatus === "triggered") return "firing";
  return m.lastStatus === "error" ? "error" : "ok";
}

interface MonitorCardProps {
  monitor: MonitorRow;
  since: string;
  rangeLabel: string;
  spanClass: string;
  isDragging: boolean;
  isTarget: boolean;
  resizeActive: boolean;
  onNavigate: (sessionId: string) => void;
  onEdit: (id: string) => void;
  onDragStartId: (id: string) => void;
  onDragEnd: () => void;
  onOverId: (id: string) => void;
  onDropId: (id: string) => void;
  onResizeStart: (id: string, e: React.PointerEvent) => void;
}

export const MonitorCard = memo(function MonitorCard({
  monitor, since, rangeLabel, spanClass, isDragging, isTarget, resizeActive,
  onNavigate, onEdit, onDragStartId, onDragEnd, onOverId, onDropId, onResizeStart,
}: MonitorCardProps) {
  const [queryOpen, setQueryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const utils = trpc.useUtils();
  const onError = (e: { message: string }) => {
    toast.error(e.message);
    utils.monitors.list.invalidate();
  };
  const toggleRun = trpc.monitors.toggleEnabled.useMutation({ onError, onSuccess: () => utils.monitors.list.invalidate() });
  // Both toggles refetch on success: one change can fire both, and the later refetch must win.
  const toggleAlert = trpc.monitors.setAlertEnabled.useMutation({ onError, onSuccess: () => utils.monitors.list.invalidate() });
  const remove = trpc.monitors.delete.useMutation({
    onSuccess: () => { utils.monitors.list.invalidate(); toast("Monitor deleted"); },
    onError: (e) => toast.error(e.message),
  });

  const state = stateOf(monitor);
  const stateInfo = STATES.find((s) => s.value === state)!;
  const status = statusOf(monitor);
  const badge = STATUS_BADGE[status];
  const provider = providerLabel(monitor.provider);
  const condition = `Fires when count ${monitor.condition}`;
  const frequency = formatFrequency(monitor.frequencySeconds);
  const ranAt = !monitor.enabled ? "paused" : monitor.lastRunAt === null ? "not run yet" : `ran ${formatTime(monitor.lastRunAt)}`;

  const setState = (next: MonitorState) => {
    if (next === state) return;
    const run = next !== "paused";
    const alert = next === "active";
    utils.monitors.list.setData(undefined, (rows) => rows?.map((m) => (
      m.id === monitor.id ? { ...m, enabled: run ? 1 : 0, alertEnabled: run ? (alert ? 1 : 0) : m.alertEnabled } : m
    )));
    const calls: Promise<unknown>[] = [];
    if (!!monitor.enabled !== run) calls.push(toggleRun.mutateAsync({ id: monitor.id, enabled: run }));
    if (run && !!monitor.alertEnabled !== alert) calls.push(toggleAlert.mutateAsync({ id: monitor.id, enabled: alert }));
    // onError already toasts the failure.
    Promise.all(calls).then(() => toast(`${monitor.name} ${STATE_TOAST[next]}`), () => {});
  };

  return (
    <article
      id={`monitor-${monitor.id}`}
      aria-labelledby={`monitor-${monitor.id}-name`}
      onDragOver={(e) => { e.preventDefault(); onOverId(monitor.id); }}
      onDrop={(e) => { e.preventDefault(); onDropId(monitor.id); }}
      className={cn(
        "group relative flex min-w-0 scroll-mt-20 flex-col rounded-lg border bg-card transition-opacity",
        status === "firing" && "border-destructive/30",
        (isTarget || resizeActive) && "outline-2 outline-offset-2 outline-muted-foreground outline-dashed",
        isDragging && "opacity-50",
        spanClass,
      )}
    >
      <div
        onPointerDown={(e) => onResizeStart(monitor.id, e)}
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 -right-1.5 z-10 hidden w-3 cursor-ew-resize items-center justify-center transition-opacity min-[1100px]:flex",
          resizeActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <div className="h-10 w-1 rounded-full bg-muted-foreground" />
      </div>

      <div className="space-y-3 p-4 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                draggable
                aria-label="Drag to reorder"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", monitor.id);
                  const card = e.currentTarget.closest<HTMLElement>("article");
                  if (card) e.dataTransfer.setDragImage(card, 16, 16);
                  onDragStartId(monitor.id);
                }}
                onDragEnd={onDragEnd}
                className="absolute top-[22px] left-0 hidden cursor-grab text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground active:cursor-grabbing min-[1100px]:block [@media(hover:none)]:opacity-100"
              >
                <GripVertical className="size-4" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Drag to reorder</TooltipContent>
          </Tooltip>
          <Badge className={cn("rounded-md", badge.className)}>{badge.label}</Badge>
          <div className="flex min-w-0 flex-1 items-center gap-2 max-sm:order-last max-sm:basis-full">
            <h2 id={`monitor-${monitor.id}-name`} title={monitor.name} className="min-w-0 truncate text-base font-semibold tracking-tight">
              {monitor.name}
            </h2>
            {monitor.unreadCount > 0 && (
              <Badge aria-label={`${monitor.unreadCount} unread`} className="min-w-5 rounded-full px-1.5 tabular-nums">
                {monitor.unreadCount}
              </Badge>
            )}
          </div>
          <span className="flex-1 sm:hidden" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" aria-label={`State: ${stateInfo.label}`}>
                <span className={cn("size-1.5 rounded-full", stateInfo.dot)} aria-hidden="true" />
                {stateInfo.label}
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuRadioGroup value={state} onValueChange={(v) => setState(v as MonitorState)}>
                {STATES.map((s) => (
                  <DropdownMenuRadioItem key={s.value} value={s.value} className="items-start py-2 pr-8">
                    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", s.dot)} aria-hidden="true" />
                    <span className="flex flex-col gap-0.5">
                      <span>{s.label}</span>
                      <span className="text-xs text-muted-foreground">{s.description}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <MoreActionsMenu label={`More actions for ${monitor.name}`} triggerClassName="size-7">
            <DropdownMenuItem onSelect={() => onEdit(monitor.id)}>Edit with agent</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setQueryOpen(true)}>View query</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={remove.isPending} onSelect={() => setConfirmDelete(true)}>
              Delete monitor
            </DropdownMenuItem>
          </MoreActionsMenu>
        </div>

        <p className="flex min-w-0 items-start gap-1.5 text-[13px] leading-[18px] text-ink-2">
          <span className="flex h-[18px] items-center"><ProviderDot provider={monitor.provider} /></span>
          <span className="tabular-nums">{provider} · {condition} · {frequency} · {ranAt}</span>
        </p>
        {monitor.lastError && (
          <p className="flex items-start gap-1.5 text-[13px] leading-[18px] text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{monitor.lastError}</span>
          </p>
        )}
      </div>

      <MonitorChart
        provider={monitor.provider}
        query={monitor.query}
        condition={monitor.condition}
        chartQuery={monitor.chartQuery}
        lastRunAt={monitor.lastRunAt}
        since={since}
        className="border-t-0 px-4 pt-0 pb-3"
      />

      <div className="mt-auto border-t px-2 py-1.5">
        <MonitorTriggers monitorId={monitor.id} lastRunAt={monitor.lastRunAt} since={since} rangeLabel={rangeLabel} onNavigate={onNavigate} />
      </div>

      <Dialog open={queryOpen} onOpenChange={setQueryOpen}>
        <DialogContent className="sm:max-w-xl" onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
          <DialogHeader>
            <DialogTitle>{monitor.name}</DialogTitle>
            <DialogDescription>{provider} · {condition} · {frequency}</DialogDescription>
          </DialogHeader>
          <QueryBlock query={monitor.query} />
          {monitor.chartQuery && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Chart query</p>
              <QueryBlock query={monitor.chartQuery} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${monitor.name}"?`}
        description="Its trigger history and the sessions it opened are deleted too. This cannot be undone."
        actionLabel="Delete monitor"
        onConfirm={() => remove.mutate({ id: monitor.id })}
      />
    </article>
  );
});

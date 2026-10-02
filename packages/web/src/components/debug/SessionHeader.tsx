import { useEffect, useRef, useState, type ReactNode } from "react";
import { Brain, FileText, Minus, MoreHorizontal, Pencil, Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePolling } from "../../lib/hooks";
import { trpc } from "../../lib/trpc";
import { COLUMN } from "../chat/ChatCore";
import { downloadImage, slugify } from "../chat/MessageActions";

const MEMORY_OPS = {
  create: { icon: Plus, verb: "Saved" },
  update: { icon: Pencil, verb: "Updated" },
  delete: { icon: Minus, verb: "Deleted" },
} as const;

function MemoryBadge({ sessionId, streaming, onCostDataReady }: { sessionId: string; streaming: boolean; onCostDataReady?: () => void }) {
  const utils = trpc.useUtils();
  const memOps = trpc.memory.bySession.useQuery({ sessionId });
  const allOps = memOps.data;

  // Started/completed counts cover concurrent memory agents.
  let started = 0;
  let completed = 0;
  for (const op of allOps ?? []) {
    if (op.operation === "started") started++;
    else if (op.operation === "completed") completed++;
  }
  const agentDone = started > 0 && started === completed;
  const displayOps = allOps?.filter((op) => op.operation !== "completed" && op.operation !== "started") ?? [];

  // Stop polling after 30s when no memory agent reports back.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (streaming) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), 30_000);
    return () => clearTimeout(timer);
  }, [streaming]);

  // Refetch once when streaming ends, to pick up the "started" marker.
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current && !streaming) utils.memory.bySession.invalidate({ sessionId });
    prevStreaming.current = streaming;
  }, [streaming, sessionId, utils]);

  const prevAgentDone = useRef(false);
  useEffect(() => {
    if (!prevAgentDone.current && agentDone) onCostDataReady?.();
    prevAgentDone.current = agentDone;
  }, [agentDone, onCostDataReady]);

  const shouldPoll = !streaming && !agentDone && !timedOut && memOps.status === "success" && (allOps?.length ?? 0) > 0;
  usePolling(() => utils.memory.bySession.invalidate({ sessionId }), 3_000, shouldPoll);

  if (!displayOps.length) return null;
  const stalled = timedOut && !agentDone;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`Memory: ${displayOps.length} ${displayOps.length === 1 ? "change" : "changes"}`} className="gap-1.5 px-2 text-muted-foreground">
              <Brain />
              <span className="text-xs tabular-nums">{displayOps.length}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{stalled ? "The memory agent did not respond" : "Memory changes from this investigation"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        <p className="mb-2 text-sm font-semibold">Memory</p>
        <ul className="space-y-2">
          {displayOps.map((op) => {
            const spec = MEMORY_OPS[op.operation as keyof typeof MEMORY_OPS];
            const Icon = spec?.icon ?? Pencil;
            return (
              <li key={op.id} className="flex items-start gap-2 text-[13px]/[18px] text-ink-2">
                <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                  <Icon className="size-3" aria-hidden="true" />
                </span>
                <span>
                  <span className="font-medium text-foreground">{spec?.verb ?? op.operation}</span>
                  {op.note && `: ${op.note}`}
                </span>
              </li>
            );
          })}
        </ul>
        {stalled && <p className="mt-3 text-xs text-muted-foreground">The memory agent did not finish.</p>}
      </PopoverContent>
    </Popover>
  );
}

interface SessionHeaderProps {
  chatId: string;
  /** Resolved title; while generating, the header waits and fades it in. */
  title?: string;
  meta: string[];
  streaming?: boolean;
  /** Blocks Post-mortem and Compact (streaming or compacting). */
  busy?: boolean;
  readOnly?: boolean;
  onPostMortem?: () => void;
  /** Enters compact-selection mode. Omit to hide Compact. */
  onCompact?: () => void;
  onCopyText: () => void;
  onDelete: () => void;
  onTitleClick?: () => void;
  onCostDataReady?: () => void;
  /** Rendered under the header row, inside the sticky bar (compaction banner). */
  children?: ReactNode;
}

export function SessionHeader({
  chatId,
  title,
  meta,
  streaming = false,
  busy = false,
  readOnly = false,
  onPostMortem,
  onCompact,
  onCopyText,
  onDelete,
  onTitleClick,
  onCostDataReady,
  children,
}: SessionHeaderProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const postMortemBlocked = busy || streaming;

  return (
    <header ref={headerRef} className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur-md">
      <div className={cn(COLUMN, "flex items-center gap-3 py-3")}>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {title ? (
              <button
                key={title}
                type="button"
                onClick={onTitleClick}
                className="max-w-full truncate rounded-sm text-left outline-none animate-title-in focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {title}
              </button>
            ) : (
              <span className="invisible">Untitled</span>
            )}
          </h1>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className="truncate">{meta.join(" · ")}</span>
            {streaming && (
              <span className="flex shrink-0 items-center gap-1.5 font-medium text-primary">
                <span aria-hidden="true">·</span>
                <span className="size-1.5 animate-pulse-dot rounded-full bg-primary" aria-hidden="true" />
                Running
              </span>
            )}
          </p>
        </div>
        {!readOnly && <MemoryBadge sessionId={chatId} streaming={streaming} onCostDataReady={onCostDataReady} />}
        {!readOnly && onPostMortem && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-disabled={postMortemBlocked}
                onClick={postMortemBlocked ? undefined : onPostMortem}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-background max-sm:w-8 max-sm:px-0"
              >
                <FileText />
                <span className="max-sm:sr-only">Post-mortem</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{postMortemBlocked ? "Available when the run finishes" : "Write a post-mortem"}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-64">
            {!readOnly && onCompact && (
              <DropdownMenuItem disabled={busy || streaming} onSelect={onCompact} className="flex-col items-start gap-0.5">
                <span>Compact</span>
                <span className="text-xs text-muted-foreground">Summarize older replies to free up context</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onCopyText}>Copy as text</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                // The header sits first in the transcript element, so its parent is the whole session.
                const transcript = headerRef.current?.parentElement;
                if (transcript) void downloadImage(transcript, `${slugify(title ?? "investigation")}.png`);
              }}
            >
              Download image
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={streaming} onSelect={() => setConfirmDelete(true)}>
              Delete investigation
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {children}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this investigation?</AlertDialogTitle>
            <AlertDialogDescription>
              {title ? `"${title}" and its queries are removed.` : "This investigation and its queries are removed."} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}

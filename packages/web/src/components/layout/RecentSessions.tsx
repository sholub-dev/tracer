import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { SESSION_KIND } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePersistedState } from "../../lib/hooks";
import { trpc } from "../../lib/trpc";
import { ImportDropZone } from "./ImportDropZone";

type Kind = "chat" | "alert" | "api" | "imported";
type Filter = "all" | Kind;
type Day = "today" | "yesterday" | "earlier";

interface SessionItem {
  id: string;
  title: string;
  status: string;
  kind: string | null;
  updatedAt: number;
}

const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "chat", label: "Chats" },
  { value: "alert", label: "Alerts" },
  { value: "api", label: "API" },
  { value: "imported", label: "Imported" },
];

const days: { day: Day; label: string }[] = [
  { day: "today", label: "Today" },
  { day: "yesterday", label: "Yesterday" },
  { day: "earlier", label: "Earlier" },
];

function kindOf(kind: string | null): Kind {
  switch (kind) {
    case SESSION_KIND.MONITOR: return "alert";
    case SESSION_KIND.API: return "api";
    case SESSION_KIND.IMPORTED: return "imported";
    default: return "chat";
  }
}

const kindLabel: Record<Kind, string> = {
  chat: "Chat",
  alert: "Alert",
  api: "API",
  imported: "Imported",
};

function dayOf(date: Date): Day {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (date >= start) return "today";
  start.setDate(start.getDate() - 1);
  return date >= start ? "yesterday" : "earlier";
}

interface RecentSessionsProps {
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onDeleted: (id: string) => void;
  onImported: (id: string) => void;
}

export function RecentSessions({ currentSessionId, onSelectSession, onDeleted, onImported }: RecentSessionsProps) {
  // Live updates arrive over the session change stream; focus refetch is only a safety net.
  const sessionsQuery = trpc.sessions.list.useQuery(undefined, { refetchOnWindowFocus: true });
  const utils = trpc.useUtils();
  const deleteMutation = trpc.sessions.delete.useMutation();
  const [filter, setFilter] = usePersistedState<Filter>("tracer:sidebarFilter", "all");
  const [deleting, setDeleting] = useState<SessionItem | null>(null);

  // Rows seen at least once render still; only rows that arrive later animate in.
  const [seen, setSeen] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (sessionsQuery.data) setSeen(new Set(sessionsQuery.data.map((s) => s.id)));
  }, [sessionsQuery.data]);

  const visible = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => filter === "all" || kindOf(s.kind) === filter),
    [sessionsQuery.data, filter],
  );

  const confirmDelete = () => {
    if (!deleting) return;
    const { id } = deleting;
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          utils.sessions.list.invalidate();
          utils.monitors.triggers.invalidate();
          utils.monitors.list.invalidate();
          onDeleted(id);
          toast("Investigation deleted");
        },
        onError: () => toast.error("Couldn't delete the investigation"),
      },
    );
  };

  return (
    <SidebarGroup className="px-3">
      <SidebarGroupLabel className="px-2 text-xs text-muted-foreground">Recent</SidebarGroupLabel>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0.5}
        aria-label="Filter recent investigations"
        value={filter}
        onValueChange={(v) => v && setFilter(v as Filter)}
        className="mb-2 w-full rounded-lg bg-muted p-0.5"
      >
        {filters.map((f) => (
          <ToggleGroupItem
            key={f.value}
            value={f.value}
            className="h-7 min-w-0 flex-auto rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs"
          >
            {f.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {filter === "imported" && <ImportDropZone onImported={onImported} />}
      {days.map(({ day, label }) => {
        const rows = visible.filter((s) => dayOf(new Date(s.updatedAt * 1000)) === day);
        if (!rows.length) return null;
        return (
          <section key={day} aria-label={label} className="mt-2">
            <h3 className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{label}</h3>
            <SidebarMenu>
              {rows.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  day={day}
                  active={currentSessionId === s.id}
                  animateIn={seen !== null && !seen.has(s.id)}
                  onSelect={() => onSelectSession(s.id)}
                  onDelete={() => setDeleting(s)}
                />
              ))}
            </SidebarMenu>
          </section>
        );
      })}
      {sessionsQuery.data && !visible.length && (
        <p className="px-2 py-6 text-center text-[13px]/[18px] text-muted-foreground">Nothing here yet</p>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this investigation?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.title}" and its queries are removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  );
}

interface SessionRowProps {
  session: SessionItem;
  day: Day;
  active: boolean;
  animateIn: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function SessionRow({ session: s, day, active, animateIn, onSelect, onDelete }: SessionRowProps) {
  // Captured at mount so the classes stay stable and each animation plays once.
  const [enter] = useState(animateIn);
  const [firstTitle] = useState(s.title);
  const running = s.status === "streaming";
  const unread = s.status === "done" && !active;
  const date = new Date(s.updatedAt * 1000);
  const when = day === "earlier"
    ? date.toLocaleDateString([], { month: "short", day: "numeric" })
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <SidebarMenuItem className={cn(enter && "animate-row-in")}>
      <SidebarMenuButton size="lg" isActive={active} onClick={onSelect} className="h-auto items-start gap-0 py-1.5 pl-0">
        <span className="flex h-5 w-8 shrink-0 items-center justify-center" aria-hidden="true">
          {(unread || running) && <span className={cn("size-1.5 rounded-full bg-primary", running && "animate-pulse-dot")} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            key={s.title}
            className={cn("truncate text-sm", unread && "font-semibold", s.title !== firstTitle && "animate-title-in")}
          >
            {s.title}
            {unread && <span className="sr-only"> (unread)</span>}
          </span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {kindLabel[kindOf(s.kind)]} · {when}
            {running && " · running"}
          </span>
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <SidebarMenuAction
                showOnHover
                aria-label={`More actions for ${s.title}`}
                className="top-2! size-6 w-6 [@media(hover:none)]:opacity-100"
              >
                <MoreHorizontal />
              </SidebarMenuAction>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" className="w-48">
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

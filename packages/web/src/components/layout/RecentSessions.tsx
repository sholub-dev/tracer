import { memo, startTransition, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { formatClock, formatShortDate } from "../../lib/format";
import { useDeleteSession, usePersistedState } from "../../lib/hooks";
import { sessionKindKey, sessionKindLabel, type SessionKindKey } from "../../lib/session-kind";
import { trpc } from "../../lib/trpc";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { MoreActionsMenu } from "../common/MoreActionsMenu";
import { SegmentedControl } from "../common/SegmentedControl";
import { ImportDropZone } from "./ImportDropZone";

type Filter = "all" | SessionKindKey;
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

function dayOf(date: Date): Day {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (date >= start) return "today";
  start.setDate(start.getDate() - 1);
  return date >= start ? "yesterday" : "earlier";
}

// Rows past this paint in a follow-up render, so a click shows the top of the list first.
const FIRST_ROWS = 40;

interface RecentSessionsProps {
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onDeleted: (id: string) => void;
  onImported: (id: string) => void;
}

export const RecentSessions = memo(function RecentSessions({ currentSessionId, onSelectSession, onDeleted, onImported }: RecentSessionsProps) {
  // Live updates arrive over the session change stream; focus refetch is only a safety net.
  const sessionsQuery = trpc.sessions.list.useQuery(undefined, { refetchOnWindowFocus: true });
  const deleteSession = useDeleteSession({ onDeleted });
  const [filter, setFilter] = usePersistedState<Filter>("tracer:sidebarFilter", "all");
  const [deleting, setDeleting] = useState<SessionItem | null>(null);

  // Rows seen at least once render still; only rows that arrive later animate in.
  const [seen, setSeen] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (sessionsQuery.data) setSeen(new Set(sessionsQuery.data.map((s) => s.id)));
  }, [sessionsQuery.data]);

  const visible = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => filter === "all" || sessionKindKey(s.kind) === filter),
    [sessionsQuery.data, filter],
  );

  const [rowLimit, setRowLimit] = useState(FIRST_ROWS);
  const changeFilter = (next: Filter) => {
    setRowLimit(FIRST_ROWS);
    setFilter(next);
  };
  useEffect(() => {
    if (rowLimit >= visible.length) return;
    const timer = setTimeout(() => startTransition(() => setRowLimit(Infinity)), 0);
    return () => clearTimeout(timer);
  }, [rowLimit, visible.length]);
  const shown = rowLimit < visible.length ? visible.slice(0, rowLimit) : visible;

  return (
    <SidebarGroup className="px-3">
      <SidebarGroupLabel className="px-2 text-xs text-muted-foreground">Recent</SidebarGroupLabel>
      <SegmentedControl
        label="Filter recent investigations"
        value={filter}
        onValueChange={changeFilter}
        options={filters}
        className="mb-2 w-full"
        itemClassName="flex-auto px-1.5"
      />
      {filter === "imported" && <ImportDropZone onImported={onImported} />}
      {days.map(({ day, label }) => {
        const rows = shown.filter((s) => dayOf(new Date(s.updatedAt * 1000)) === day);
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
                  onSelect={onSelectSession}
                  onDelete={setDeleting}
                />
              ))}
            </SidebarMenu>
          </section>
        );
      })}
      {sessionsQuery.data && !visible.length && (
        <p className="px-2 py-6 text-center text-[13px]/[18px] text-muted-foreground">Nothing here yet</p>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this investigation?"
        description={`"${deleting?.title}" and its queries are removed. This cannot be undone.`}
        actionLabel="Delete"
        onConfirm={() => deleting && deleteSession(deleting.id)}
      />
    </SidebarGroup>
  );
});

interface SessionRowProps {
  session: SessionItem;
  day: Day;
  active: boolean;
  animateIn: boolean;
  onSelect: (id: string) => void;
  onDelete: (session: SessionItem) => void;
}

const SessionRow = memo(function SessionRow({ session: s, day, active, animateIn, onSelect, onDelete }: SessionRowProps) {
  // Captured at mount so the classes stay stable and each animation plays once.
  const [enter] = useState(animateIn);
  const [firstTitle] = useState(s.title);
  const running = s.status === "streaming";
  const unread = s.status === "done" && !active;
  const when = day === "earlier" ? formatShortDate(s.updatedAt) : formatClock(s.updatedAt);

  return (
    <SidebarMenuItem className={cn(enter && "animate-row-in")}>
      <SidebarMenuButton size="lg" isActive={active} onClick={() => onSelect(s.id)} className="h-auto items-start gap-0 py-1.5 pl-0">
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
            {sessionKindLabel(s.kind)} · {when}
            {running && " · running"}
          </span>
        </span>
      </SidebarMenuButton>
      <MoreActionsMenu lazy label={`More actions for ${s.title}`} sidebar side="right" align="start" triggerClassName="top-2! size-6 w-6">
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(s)}>Delete</DropdownMenuItem>
      </MoreActionsMenu>
    </SidebarMenuItem>
  );
});

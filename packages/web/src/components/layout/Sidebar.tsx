import { useCallback, useEffect, useState } from "react";
import { Activity, CircleCheck, LayoutDashboard, MessageSquare, MoreHorizontal, Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { FEATURES, SESSION_KIND } from "@tracer-sh/shared";
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
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionLiveUpdates } from "../../lib/hooks";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { RecentSessions } from "./RecentSessions";
import { UpdateModal } from "./UpdateModal";

declare const __APP_VERSION__: string;

export type Page = "dashboard" | "debug" | "monitors" | "settings";

interface AppSidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  currentDashboardId: string | null;
  onSelectDashboard: (id: string) => void;
  onNewDashboard: () => void;
}

export function AppSidebar({
  currentPage,
  onNavigate,
  currentSessionId,
  onSelectSession,
  onNewSession,
  currentDashboardId,
  onSelectDashboard,
  onNewDashboard,
}: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();
  const sessionsQuery = trpc.sessions.list.useQuery(undefined, { refetchOnWindowFocus: true });
  const monitorsQuery = trpc.monitors.list.useQuery(undefined, { enabled: FEATURES.monitors });
  const activeStatusQuery = trpc.sessions.activeCount.useQuery(undefined, { refetchOnWindowFocus: true });
  const utils = trpc.useUtils();
  useSessionLiveUpdates();

  const markViewedMutation = trpc.sessions.markViewed.useMutation();

  // If the user is viewing a session and polling returns it as "done", fix it to "idle".
  useEffect(() => {
    if (!currentSessionId || currentPage !== "debug" || !sessionsQuery.data) return;
    const current = sessionsQuery.data.find(s => s.id === currentSessionId);
    if (!current || current.status !== "done") return;
    utils.sessions.list.setData(undefined, (prev) =>
      prev?.map(s => s.id === currentSessionId ? { ...s, status: "idle" } : s),
    );
    utils.sessions.activeCount.setData(undefined, (prev) =>
      prev ? { ...prev, done: Math.max(0, prev.done - 1) } : prev,
    );
    markViewedMutation.mutate({ id: currentSessionId });
  }, [sessionsQuery.data, currentSessionId, currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const doneSessionCount = currentPage === "debug" && sessionsQuery.data
    ? sessionsQuery.data.filter(s => s.status === "done" && s.id !== currentSessionId && s.kind !== SESSION_KIND.API).length
    : (activeStatusQuery.data?.done ?? 0);
  const inSavedSession = !!sessionsQuery.data?.some(s => s.id === currentSessionId);

  const go = (fn: () => void) => {
    fn();
    setOpenMobile(false);
  };

  const onDeleted = useCallback((id: string) => {
    if (id === currentSessionId) onNewSession();
  }, [currentSessionId, onNewSession]);

  const onImported = useCallback((id: string) => {
    onSelectSession(id);
    setOpenMobile(false);
  }, [onSelectSession, setOpenMobile]);

  return (
    <Sidebar>
      <SidebarHeader className="gap-3 px-3 pt-4">
        <div className="flex items-center gap-2 px-1">
          <img src="/logo.svg" alt="" className="size-5" />
          <span className="text-base font-semibold tracking-tight">Tracer</span>
        </div>
        <Button variant="outline" className="w-full justify-start bg-card" onClick={() => go(onNewSession)}>
          <Plus />
          New investigation
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="px-3 py-1">
          <SidebarMenu>
            {FEATURES.dashboards && (
              <DashboardNav
                active={currentPage === "dashboard"}
                currentDashboardId={currentDashboardId}
                onOpen={() => go(() => onNavigate("dashboard"))}
                onSelect={(id) => go(() => onSelectDashboard(id))}
                onNew={() => go(onNewDashboard)}
                onDeleted={(id) => { if (id === currentDashboardId) onNavigate("dashboard"); }}
              />
            )}
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={currentPage === "debug" && !inSavedSession}
                onClick={() => go(() => onNavigate("debug"))}
              >
                <MessageSquare />
                <span>Investigations</span>
              </SidebarMenuButton>
              {doneSessionCount > 0 && (
                <SidebarMenuBadge className="text-primary" aria-label={`${doneSessionCount} unread`}>
                  {doneSessionCount}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            {FEATURES.monitors && (
              <SidebarMenuItem>
                <SidebarMenuButton isActive={currentPage === "monitors"} onClick={() => go(() => onNavigate("monitors"))}>
                  <Activity />
                  <span>Monitors</span>
                </SidebarMenuButton>
                {monitorsQuery.data && (
                  <SidebarMenuBadge className="text-muted-foreground tabular-nums">{monitorsQuery.data.length}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>

        <RecentSessions
          currentSessionId={currentPage === "debug" ? currentSessionId : null}
          onSelectSession={(id) => go(() => onSelectSession(id))}
          onDeleted={onDeleted}
          onImported={onImported}
        />
      </SidebarContent>

      <SidebarFooter className="flex-row items-center gap-2 border-t border-sidebar-border px-3 py-2">
        <VersionStatus />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Settings"
              aria-current={currentPage === "settings" ? "page" : undefined}
              className={cn(currentPage === "settings" && "bg-sidebar-accent text-foreground")}
              onClick={() => go(() => onNavigate("settings"))}
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Settings</TooltipContent>
        </Tooltip>
      </SidebarFooter>
    </Sidebar>
  );
}

function VersionStatus() {
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
  });
  const version = updateCheck.data?.currentVersion ?? __APP_VERSION__;

  if (updateCheck.data?.available) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowUpdateModal(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="size-1.5 rounded-full bg-primary animate-pulse-dot" />
          </span>
          <span className="truncate">
            Tracer {version} · <span className="text-primary">update available</span>
          </span>
        </button>
        <UpdateModal open={showUpdateModal} onClose={() => setShowUpdateModal(false)} />
      </>
    );
  }

  return (
    <>
      {updateCheck.data && <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />}
      <span className="flex-1 truncate text-xs text-muted-foreground tabular-nums">
        Tracer {version}{updateCheck.data && " · up to date"}
      </span>
    </>
  );
}

interface DashboardNavProps {
  active: boolean;
  currentDashboardId: string | null;
  onOpen: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
}

function DashboardNav({ active, currentDashboardId, onOpen, onSelect, onNew, onDeleted }: DashboardNavProps) {
  const dashboardsQuery = trpc.dashboards.list.useQuery(undefined, { enabled: active });
  const utils = trpc.useUtils();
  const deleteMutation = trpc.dashboards.delete.useMutation();
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  const confirmDelete = () => {
    if (!deleting) return;
    const { id } = deleting;
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          utils.dashboards.list.invalidate();
          onDeleted(id);
          toast("Dashboard deleted");
        },
        onError: () => toast.error("Couldn't delete the dashboard"),
      },
    );
  };

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={active && !currentDashboardId} onClick={onOpen}>
          <LayoutDashboard />
          <span>Dashboard</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {active && (
        <>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" className="pl-8 text-muted-foreground" onClick={onNew}>
              <Plus />
              <span>New dashboard</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {dashboardsQuery.data?.map((d) => (
            <SidebarMenuItem key={d.id}>
              <SidebarMenuButton size="sm" className="pl-8" isActive={currentDashboardId === d.id} onClick={() => onSelect(d.id)}>
                <span>{d.title}</span>
              </SidebarMenuButton>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover aria-label={`More actions for ${d.title}`} className="[@media(hover:none)]:opacity-100">
                        <MoreHorizontal />
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="right">More actions</TooltipContent>
                </Tooltip>
                <DropdownMenuContent side="right" align="start" className="w-48">
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(d)}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          ))}
        </>
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.title}" and all its widgets are removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

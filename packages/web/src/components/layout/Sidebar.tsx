import { useCallback, useState } from "react";
import { Activity, CircleCheck, LayoutDashboard, Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { FEATURES } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSessionLiveUpdates } from "../../lib/hooks";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { IS_IOS } from "../../lib/platform";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { IconButton } from "../common/IconButton";
import { MoreActionsMenu } from "../common/MoreActionsMenu";
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
  const monitorsQuery = trpc.monitors.list.useQuery(undefined, { enabled: FEATURES.monitors });
  useSessionLiveUpdates();

  const go = (fn: () => void) => {
    fn();
    setOpenMobile(false);
  };

  const onDeleted = useCallback((id: string) => {
    if (id === currentSessionId) onNewSession();
  }, [currentSessionId, onNewSession]);

  const openSession = useCallback((id: string) => {
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
            {__DASHBOARDS__ && (
              <DashboardNav
                active={currentPage === "dashboard"}
                currentDashboardId={currentDashboardId}
                onOpen={() => go(() => onNavigate("dashboard"))}
                onSelect={(id) => go(() => onSelectDashboard(id))}
                onNew={() => go(onNewDashboard)}
                onDeleted={(id) => { if (id === currentDashboardId) onNavigate("dashboard"); }}
              />
            )}
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
          onSelectSession={openSession}
          onDeleted={onDeleted}
          onImported={openSession}
        />
      </SidebarContent>

      <SidebarFooter className="flex-row items-center gap-2 border-t border-sidebar-border px-3 py-2">
        <VersionStatus />
        <IconButton
          label="Settings"
          side="top"
          aria-current={currentPage === "settings" ? "page" : undefined}
          className={cn(currentPage === "settings" && "bg-sidebar-accent text-foreground")}
          onClick={() => go(() => onNavigate("settings"))}
        >
          <Settings />
        </IconButton>
      </SidebarFooter>
    </Sidebar>
  );
}

function VersionStatus() {
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
    enabled: !IS_IOS,
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
              <MoreActionsMenu label={`More actions for ${d.title}`} sidebar side="right" align="start">
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(d)}>Delete</DropdownMenuItem>
              </MoreActionsMenu>
            </SidebarMenuItem>
          ))}
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this dashboard?"
        description={`"${deleting?.title}" and all its widgets are removed. This cannot be undone.`}
        actionLabel="Delete"
        onConfirm={confirmDelete}
      />
    </>
  );
}

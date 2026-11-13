import { useCallback, useState } from "react";
import { Activity, CircleCheck, Plus, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { navigate, useSessionLiveUpdates } from "../../lib/hooks";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { IS_IOS } from "../../lib/platform";
import { IconButton } from "../common/IconButton";
import { useAlertBanners } from "./AlertBanner";
import { RecentSessions } from "./RecentSessions";
import { UpdateModal } from "./UpdateModal";

declare const __APP_VERSION__: string;

export type Page = "debug" | "monitors" | "settings";

interface AppSidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
}

export function AppSidebar({
  currentPage,
  onNavigate,
  currentSessionId,
  onSelectSession,
  onNewSession,
}: AppSidebarProps) {
  const { setOpenMobile } = useSidebar();
  const monitorsQuery = trpc.monitors.list.useQuery();
  useSessionLiveUpdates();

  const go = (fn: () => void) => {
    fn();
    setOpenMobile(false);
  };

  const onDeleted = useCallback((id: string) => {
    // Replace the deleted session's history entry: Back must not return to it. A bare "/" gets a fresh session id.
    if (id === currentSessionId) {
      navigate("/", true);
    }
  }, [currentSessionId]);

  const openSession = useCallback((id: string) => {
    onSelectSession(id);
    setOpenMobile(false);
  }, [onSelectSession, setOpenMobile]);

  useAlertBanners(openSession, currentPage === "debug" ? currentSessionId : null);

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
            <SidebarMenuItem>
              <SidebarMenuButton isActive={currentPage === "monitors"} onClick={() => go(() => onNavigate("monitors"))}>
                <Activity />
                <span>Monitors</span>
              </SidebarMenuButton>
              {monitorsQuery.data && (
                <SidebarMenuBadge className="text-muted-foreground">{monitorsQuery.data.length}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <RecentSessions
          currentSessionId={currentPage === "debug" ? currentSessionId : null}
          onSelectSession={openSession}
          onDeleted={onDeleted}
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
    refetchInterval: WEB_CONFIG.updateCheckIntervalMs,
    refetchOnWindowFocus: true,
    enabled: !IS_IOS,
  });
  const version = updateCheck.data?.currentVersion ?? __APP_VERSION__;

  // "unknown": the server could not read its version, and a reload does not change that.
  const reloadNeeded = !!updateCheck.data && updateCheck.data.currentVersion !== "unknown" && updateCheck.data.currentVersion !== __APP_VERSION__;
  if (reloadNeeded || updateCheck.data?.available) {
    return (
      <>
        <button
          type="button"
          onClick={reloadNeeded ? () => window.location.reload() : () => setShowUpdateModal(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="size-1.5 rounded-full bg-primary" />
          </span>
          <span className="truncate">
            {reloadNeeded ? <span className="text-primary">Reload to finish updating</span> : <>Tracer {version} · <span className="text-primary">update available</span></>}
          </span>
        </button>
        {!reloadNeeded && <UpdateModal open={showUpdateModal} onClose={() => setShowUpdateModal(false)} />}
      </>
    );
  }

  return (
    <>
      {updateCheck.data && <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />}
      <span className="flex-1 truncate text-xs text-muted-foreground">
        Tracer {version}{updateCheck.data && " · up to date"}
      </span>
    </>
  );
}

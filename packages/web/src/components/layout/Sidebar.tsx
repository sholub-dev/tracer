import { useEffect, useState } from "react";
import { usePolling } from "../../lib/hooks";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { ScrollableList } from "./ScrollableList";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { UpdateModal } from "./UpdateModal";

declare const __APP_VERSION__: string;

export type Page = "dashboard" | "debug" | "monitors" | "settings";

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  currentDashboardId: string | null;
  onSelectDashboard: (id: string) => void;
  onNewDashboard: () => void;
}

const NavIcon = ({ page }: { page: Page }) => {
  const props = { width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.5 };
  switch (page) {
    case "dashboard":
      return <svg {...props} viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5" /></svg>;
    case "debug":
      return <svg {...props} viewBox="0 0 16 16"><path d="M8 1.5L14.5 8L8 14.5L1.5 8Z" /></svg>;
    case "monitors":
      return <svg {...props} viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /></svg>;
    case "settings":
      return <svg {...props} viewBox="0 0 16 16"><path d="M3 4.5h10M3 8h10M3 11.5h10" /></svg>;
  }
};

const navItems: { page: Page; label: string }[] = [
  // { page: "dashboard", label: "Dashboard" },
  { page: "debug", label: "Debug" },
  // { page: "monitors", label: "Monitors" },
];

export function Sidebar({
  currentPage,
  onNavigate,
  currentSessionId,
  onSelectSession,
  onNewSession,
  currentDashboardId,
  onSelectDashboard,
  onNewDashboard,
}: SidebarProps) {
  const sessionsQuery = trpc.sessions.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const dashboardsQuery = trpc.dashboards.list.useQuery(undefined, {
    enabled: currentPage === "dashboard",
  });
  const alertCountQuery = trpc.monitorAlerts.activeCount.useQuery();
  const activeStatusQuery = trpc.sessions.activeCount.useQuery();
  const utils = trpc.useUtils();

  const hasActiveStreams = (activeStatusQuery.data?.streaming ?? 0) > 0;
  usePolling(() => {
    utils.sessions.activeCount.invalidate();
    if (currentPage === "debug") utils.sessions.list.invalidate();
  }, 5_000, hasActiveStreams);

  const shouldPollMonitors = trpc.monitors.shouldPoll.useQuery();
  usePolling(() => {
    utils.monitorAlerts.activeCount.invalidate();
    utils.monitors.shouldPoll.invalidate();
  }, 60_000, shouldPollMonitors.data ?? false);

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

  const alertCount = alertCountQuery.data ?? 0;
  const doneSessionCount = currentPage === "debug" && sessionsQuery.data
    ? sessionsQuery.data.filter(s => s.status === "done" && s.id !== currentSessionId).length
    : (activeStatusQuery.data?.done ?? 0);

  const deleteSessionMutation = trpc.sessions.delete.useMutation();
  const deleteDashboardMutation = trpc.dashboards.delete.useMutation();

  const [confirmTarget, setConfirmTarget] = useState<{ type: "session" | "dashboard"; id: string } | null>(null);

  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const updateAvailable = updateCheck.data?.available === true;

  const handleDeleteSession = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfirmTarget({ type: "session", id });
  };

  const handleDeleteDashboard = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfirmTarget({ type: "dashboard", id });
  };

  const handleConfirmDelete = () => {
    if (!confirmTarget) return;
    if (confirmTarget.type === "session") {
      deleteSessionMutation.mutate(
        { id: confirmTarget.id },
        {
          onSuccess: () => {
            utils.sessions.list.invalidate();
            if (currentSessionId === confirmTarget.id) onNewSession();
          },
        },
      );
    } else {
      deleteDashboardMutation.mutate(
        { id: confirmTarget.id },
        {
          onSuccess: () => {
            utils.dashboards.list.invalidate();
            if (currentDashboardId === confirmTarget.id) {
              onNavigate("dashboard");
            }
          },
        },
      );
    }
    setConfirmTarget(null);
  };

  return (
    <div className={`flex flex-col h-full ${theme.sidebar}`}>
      <div className="p-6">
        <h1 className={`text-2xl font-bold ${theme.sidebarLogo} flex items-center gap-2`}>
          <img src="/logo.svg" alt="" className="w-6 h-6" />
          OKO
        </h1>
        <p className={`text-xs mt-1 ${theme.sidebarSubtitle}`}>
          Observability Platform
        </p>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
        {navItems.map(({ page, label }) => {
          const active = currentPage === page;
          return (
            <div key={page}>
              <button
                onClick={() => onNavigate(page)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-sm text-sm transition-colors ${
                  active ? theme.navActive : theme.navInactive
                }`}
              >
                {page === "monitors" && alertCount > 0 ? (
                  <span className="relative flex items-center justify-center w-5 shrink-0">
                    <NavIcon page={page} />
                    <span
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ animation: "fill-up-down 4s ease-in-out infinite" }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#b33a2a" stroke="none" /></svg>
                    </span>
                  </span>
                ) : (page === "debug" && doneSessionCount > 0) ? (
                  <span className="relative flex items-center justify-center w-5 shrink-0">
                    <NavIcon page={page} />
                    <span
                      className="absolute inset-0 flex items-center justify-center"
                      style={{ animation: "fill-up-down 4s ease-in-out infinite" }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1.5L14.5 8L8 14.5L1.5 8Z" fill="#2b5ea7" stroke="none" /></svg>
                    </span>
                  </span>
                ) : (
                  <span className="w-5 flex items-center justify-center shrink-0"><NavIcon page={page} /></span>
                )}
                {label}
                {page === "monitors" && alertCount > 0 && (
                  <span className="ml-auto flex items-center gap-1.5">
                    <span className="text-[10px] font-medium text-[#b33a2a]">{alertCount}</span>
                  </span>
                )}
              </button>

              {page === "dashboard" && currentPage === "dashboard" && (
                <div className="mt-1 space-y-0.5">
                  <button
                    onClick={onNewDashboard}
                    className={theme.sessionNewBtn}
                  >
                    <span className="text-[10px]">+</span>
                    New dashboard
                  </button>
                  <ScrollableList>
                    {dashboardsQuery.data?.map((dashboard) => (
                      <button
                        key={dashboard.id}
                        onClick={() => onSelectDashboard(dashboard.id)}
                        className={
                          currentDashboardId === dashboard.id
                            ? theme.sessionItemActive
                            : theme.sessionItem
                        }
                      >
                        <span className="truncate flex-1 text-left">
                          {dashboard.title}
                        </span>
                        <span
                          onClick={(e) => handleDeleteDashboard(e, dashboard.id)}
                          className={theme.sessionDeleteBtn}
                        >
                          ×
                        </span>
                      </button>
                    ))}
                  </ScrollableList>
                </div>
              )}

              {page === "debug" && (
                <div className="mt-1 space-y-0.5">
                  <button
                    onClick={onNewSession}
                    className={theme.sessionNewBtn}
                  >
                    <span className="text-[10px]">+</span>
                    New chat
                  </button>
                  <ScrollableList>
                    {sessionsQuery.data?.map((session) => (
                      <button
                        key={session.id}
                        onClick={() => onSelectSession(session.id)}
                        className={
                          currentSessionId === session.id
                            ? theme.sessionItemActive
                            : theme.sessionItem
                        }
                      >
                        <span
                          className={`truncate flex-1 text-left ${
                            (session.status === "streaming" || session.status === "done") && session.id !== currentSessionId
                              ? "text-[#2b5ea7] underline"
                              : ""
                          }`}
                          title={session.title}
                        >
                          {session.title}
                        </span>
                        <span
                          onClick={(e) => handleDeleteSession(e, session.id)}
                          className={theme.sessionDeleteBtn}
                        >
                          ×
                        </span>
                      </button>
                    ))}
                  </ScrollableList>
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="px-3 pb-2">
        <button
          onClick={() => onNavigate("settings")}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-sm text-sm transition-colors ${
            currentPage === "settings"
              ? theme.navActive
              : theme.navInactive
          }`}
        >
          <span className="w-5 flex items-center justify-center shrink-0"><NavIcon page="settings" /></span>
          Settings
        </button>
      </div>
      <div className={`p-4 ${theme.sidebarFooter}`}>
        <button
          onClick={() => updateAvailable && setShowUpdateModal(true)}
          className={`font-mono text-[10px] tracking-wider inline-flex items-center gap-1.5 ${
            updateAvailable ? "cursor-pointer hover:text-[#2b5ea7]" : "cursor-default"
          }`}
        >
          v{__APP_VERSION__}
          {updateAvailable ? (
            <span className="w-2 h-2 rounded-full bg-[#2b5ea7] animate-pulse" />
          ) : updateCheck.data && !updateCheck.isLoading ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-[#2a7a4a]">
              <path d="M2 5.5L4 7.5L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </button>
      </div>

      <UpdateModal open={showUpdateModal} onClose={() => setShowUpdateModal(false)} />

      <ConfirmDialog
        open={confirmTarget !== null}
        title={confirmTarget?.type === "session" ? "Delete session" : "Delete dashboard"}
        message={
          confirmTarget?.type === "session"
            ? "Delete this chat session?"
            : "Delete this dashboard and all its widgets?"
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

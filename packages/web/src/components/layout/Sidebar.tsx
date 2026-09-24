import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_SESSION_TITLE, FEATURES, ImportedAnalysisSchema, SESSION_KIND } from "@tracer-sh/shared";
import { useFileDrop, usePolling } from "../../lib/hooks";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { decodePngPayload } from "../../lib/png-steg";
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
  currentBuilderSessionId: string | null;
  onSelectBuilderChat: (sessionId: string) => void;
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

export function Sidebar({
  currentPage,
  onNavigate,
  currentSessionId,
  onSelectSession,
  onNewSession,
  currentDashboardId,
  onSelectDashboard,
  onNewDashboard,
  currentBuilderSessionId,
  onSelectBuilderChat,
}: SidebarProps) {
  const sessionsQuery = trpc.sessions.list.useQuery();
  const dashboardsQuery = trpc.dashboards.list.useQuery(undefined, {
    enabled: FEATURES.dashboards && currentPage === "dashboard",
  });
  const builderChatsQuery = trpc.monitors.builderChats.useQuery(undefined, {
    enabled: FEATURES.monitors,
  });
  const activeStatusQuery = trpc.sessions.activeCount.useQuery();
  const utils = trpc.useUtils();

  // Refresh the active-count (which drives the nav "done" badge) every tick. While
  // the session list is on screen, also refresh the list itself, so a session
  // created or updated anywhere shows up without a manual refresh — including a
  // headless `tracer-sh analyze` API session. The active-count deliberately
  // excludes API/imported sessions, so a count change can't be used to detect
  // them; polling the list directly does. `list` is lightweight (a few columns, no
  // message bodies), and usePolling already pauses while the tab is hidden.
  usePolling(() => {
    utils.sessions.activeCount.invalidate();
    if (currentPage === "debug") utils.sessions.list.invalidate();
    if (FEATURES.monitors) utils.monitors.builderChats.invalidate();
  }, WEB_CONFIG.activeStreamPollingMs, true);

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

  const { regularSessions, importedSessions, apiSessions } = useMemo(() => {
    const all = sessionsQuery.data ?? [];
    const regular = all.filter((s) => s.kind !== SESSION_KIND.IMPORTED && s.kind !== SESSION_KIND.API);
    const imported = all.filter((s) => s.kind === SESSION_KIND.IMPORTED);
    const api = all.filter((s) => s.kind === SESSION_KIND.API);
    return { regularSessions: regular, importedSessions: imported, apiSessions: api };
  }, [sessionsQuery.data]);

  const builderChats = builderChatsQuery.data ?? [];
  const doneSessionCount = currentPage === "debug" && sessionsQuery.data
    ? sessionsQuery.data.filter(s => s.status === "done" && s.id !== currentSessionId && s.kind !== SESSION_KIND.API).length
    : (activeStatusQuery.data?.done ?? 0);

  const deleteSessionMutation = trpc.sessions.delete.useMutation();
  const deleteDashboardMutation = trpc.dashboards.delete.useMutation();

  const [confirmTarget, setConfirmTarget] = useState<{ type: "session" | "dashboard"; id: string } | null>(null);

  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
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

  // ── Import analysis from a Tracer "Download as image" PNG ────────────────
  const [importError, setImportError] = useState<string | null>(null);
  const importMutation = trpc.sessions.importAnalysis.useMutation();

  const importPng = useCallback(async (file: File) => {
    if (file.type !== "image/png") { setImportError("Only PNG files are supported."); return; }
    if (file.size > 10 * 1024 * 1024) { setImportError("PNG is too large (>10 MB)."); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let payload: Uint8Array | null;
      try { payload = await decodePngPayload(bytes); }
      catch { setImportError("Not a valid PNG file."); return; }
      if (!payload) { setImportError("No analysis data found in this image."); return; }
      let parsed;
      try { parsed = ImportedAnalysisSchema.parse(JSON.parse(new TextDecoder().decode(payload))); }
      catch { setImportError("Analysis data is malformed or from an incompatible version."); return; }
      const { id } = await importMutation.mutateAsync(parsed);
      utils.sessions.list.setData(undefined, (prev) => {
        const row = {
          id,
          title: parsed.sourceTitle.slice(0, 80) || DEFAULT_SESSION_TITLE,
          status: "idle" as const,
          kind: SESSION_KIND.IMPORTED as string | null,
          updatedAt: Math.floor(Date.now() / 1000),
          titlePending: false,
        };
        return prev ? [row, ...prev] : [row];
      });
      setImportError(null);
      if (currentPage !== "debug") onNavigate("debug");
      onSelectSession(id);
    } catch { setImportError("Couldn't import analysis."); }
  }, [importMutation, utils, onSelectSession, onNavigate, currentPage]);

  const onImportFiles = useCallback((files: FileList) => {
    if (files.length > 1) { setImportError("Drop a single PNG to import."); return; }
    importPng(files[0]);
  }, [importPng]);
  const { dragActive: importDragActive, dropProps: importDropProps } = useFileDrop(onImportFiles);

  const handleConfirmDelete = () => {
    if (!confirmTarget) return;
    if (confirmTarget.type === "session") {
      deleteSessionMutation.mutate(
        { id: confirmTarget.id },
        {
          onSuccess: () => {
            utils.sessions.list.invalidate();
            utils.monitors.builderChats.invalidate();
            utils.monitors.triggers.invalidate();
            utils.monitors.list.invalidate();
            if (currentSessionId === confirmTarget.id) onNewSession();
            if (currentBuilderSessionId === confirmTarget.id) onNavigate("monitors");
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

  const sectionHeaderClass = "shrink-0 text-[10px] uppercase tracking-wider text-[#9c9890]/60 px-3 pt-3 pb-1";

  const renderNavButton = (page: Page, label: string) => (
    <button
      onClick={() => onNavigate(page)}
      className={`shrink-0 w-full flex items-center gap-3 px-3 py-2 rounded-sm text-sm transition-colors ${
        currentPage === page ? theme.navActive : theme.navInactive
      }`}
    >
      {page === "debug" && doneSessionCount > 0 ? (
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
    </button>
  );

  const renderSessionRow = (session: (typeof regularSessions)[number]) => (
    <button
      key={session.id}
      onClick={() => onSelectSession(session.id)}
      className={currentSessionId === session.id ? theme.sessionItemActive : theme.sessionItem}
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
      <span onClick={(e) => handleDeleteSession(e, session.id)} className={theme.sessionDeleteBtn}>
        ×
      </span>
    </button>
  );

  return (
    <div className={`flex flex-col h-full ${theme.sidebar}`}>
      <div className="p-6">
        <h1 className={`text-2xl font-bold ${theme.sidebarLogo} flex items-center gap-2`}>
          <img src="/logo.svg" alt="" className="w-6 h-6" />
          Tracer
        </h1>
        <p className={`text-xs mt-1 ${theme.sidebarSubtitle}`}>
          Observability Platform
        </p>
      </div>

      <nav className="flex-1 min-h-0 px-3 flex flex-col">
        {FEATURES.dashboards && (
          <div className="shrink-0">
            {renderNavButton("dashboard", "Dashboard")}
            {currentPage === "dashboard" && (
              <div className="mt-1 space-y-0.5">
                <button onClick={onNewDashboard} className={theme.sessionNewBtn}>
                  <span className="text-[10px]">+</span>
                  New dashboard
                </button>
                <ScrollableList>
                  {dashboardsQuery.data?.map((dashboard) => (
                    <button
                      key={dashboard.id}
                      onClick={() => onSelectDashboard(dashboard.id)}
                      className={currentDashboardId === dashboard.id ? theme.sessionItemActive : theme.sessionItem}
                    >
                      <span className="truncate flex-1 text-left">{dashboard.title}</span>
                      <span onClick={(e) => handleDeleteDashboard(e, dashboard.id)} className={theme.sessionDeleteBtn}>
                        ×
                      </span>
                    </button>
                  ))}
                </ScrollableList>
              </div>
            )}
          </div>
        )}

        <section className="flex-[8] min-h-0 flex flex-col">
          {renderNavButton("debug", "Debug")}
          <button onClick={onNewSession} className={`${theme.sessionNewBtn} mt-1 shrink-0`}>
            <span className="text-[10px]">+</span>
            New chat
          </button>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none space-y-0.5 mt-0.5">
            {regularSessions.map(renderSessionRow)}
          </div>
        </section>

        {FEATURES.monitors && (
          <section className="flex-[5] min-h-0 flex flex-col pt-2">
            {renderNavButton("monitors", "Monitors")}
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none space-y-0.5 mt-1">
              {builderChats.length === 0 ? (
                <div className="px-3 py-1 text-[11px] text-[#9c9890]/70">No monitor chats yet</div>
              ) : builderChats.map((s) => {
                const active = currentPage === "monitors" && currentBuilderSessionId === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => onSelectBuilderChat(s.id)}
                    className={active ? theme.sessionItemActive : theme.sessionItem}
                  >
                    <span
                      className={`truncate flex-1 text-left ${
                        (s.status === "streaming" || s.status === "done") && !active ? "text-[#2b5ea7] underline" : ""
                      }`}
                      title={s.title}
                    >
                      {s.title}
                    </span>
                    <span onClick={(e) => handleDeleteSession(e, s.id)} className={theme.sessionDeleteBtn}>
                      ×
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="flex-[4] min-h-0 flex flex-col">
          <div className={sectionHeaderClass}>API</div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none space-y-0.5">
            {apiSessions.map(renderSessionRow)}
          </div>
        </section>

        <section className="flex-[3] min-h-0 flex flex-col">
          <div className={sectionHeaderClass}>Imported</div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none space-y-0.5">
            <label
              className={`mx-2 mb-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] rounded border border-dashed cursor-pointer transition-colors ${
                importDragActive
                  ? "border-[#2b5ea7] bg-[#eaf0f8] text-[#2b5ea7]"
                  : "border-[#d4d2cd] text-[#9c9890] hover:text-[#2b5ea7] hover:border-[#2b5ea7]"
              }`}
              {...importDropProps}
            >
              <input
                type="file"
                accept="image/png"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importPng(f); e.target.value = ""; }}
              />
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Import analysis image
            </label>
            {importError && <div className="mx-2 mb-1 text-[10px] text-[#b33a2a]">{importError}</div>}
            {importedSessions.map(renderSessionRow)}
          </div>
        </section>
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
          v{updateCheck.data?.currentVersion ?? __APP_VERSION__}
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

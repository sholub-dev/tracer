import { type ComponentType, type CSSProperties, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { FEATURES } from "@tracer-sh/shared";
import { Loader2 } from "lucide-react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/layout/Shell";
import { AppSidebar, type Page } from "./components/layout/Sidebar";
import { AlertToaster } from "./components/layout/AlertBanner";
import { Toaster } from "@/components/ui/sonner";
import { CopyFromComputerDialog } from "@/components/settings/CopyFromComputerDialog";
import { IS_IOS } from "./lib/platform";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pages load lazily, then all of them are fetched in the background. A page already fetched renders
// directly: a lazy one suspends once on first visit, and React holds a revealed fallback for 300ms.
function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  const fetchPage = () => load().then((c) => (loaded = c));
  const Lazy = lazy(() => fetchPage().then((c) => ({ default: c })));
  function LoadedPage(props: P) {
    const [Component] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  return Object.assign(LoadedPage, { preload: () => void fetchPage().catch(() => {}) });
}

const Debug = lazyPage(() => import("./pages/Debug").then((m) => m.Debug));
const Settings = lazyPage(() => import("./pages/Settings").then((m) => m.Settings));
const Dashboard = __DASHBOARDS__ ? lazyPage(() => import("./pages/Dashboard").then((m) => m.Dashboard)) : null;
const Monitors = FEATURES.monitors ? lazyPage(() => import("./pages/Monitors").then((m) => m.Monitors)) : null;

function preloadPages() {
  const load = () => [Debug, Settings, Dashboard, Monitors].forEach((p) => p?.preload());
  if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1000);
}

const validPages = new Set<string>([
  "debug",
  "settings",
  ...(__DASHBOARDS__ ? ["dashboard"] : []),
  ...(FEATURES.monitors ? ["monitors"] : []),
]);

interface RouteState {
  page: Page;
  sessionId: string | null;
  dashboardId: string | null;
  builderSessionId: string | null;
}

function getRouteFromPath(): RouteState {
  const segments = window.location.pathname.replace(/^\/+/, "").split("/");
  const page = segments[0] && validPages.has(segments[0]) ? (segments[0] as Page) : "debug";
  const sessionId = page === "debug" && segments[1] ? segments[1] : null;
  const dashboardId = page === "dashboard" && segments[1] ? segments[1] : null;
  const builderSessionId = page === "monitors" && segments[1] === "chat" && segments[2] ? segments[2] : null;
  return { page, sessionId, dashboardId, builderSessionId };
}

// useSyncExternalStore needs the same object for the same URL, or it re-renders forever.
let cachedPath = "";
let cachedRoute: RouteState = getRouteFromPath();

function getRouteSnapshot(): RouteState {
  const path = window.location.pathname;
  if (path !== cachedPath) {
    cachedPath = path;
    cachedRoute = getRouteFromPath();
  }
  return cachedRoute;
}

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

function pushPath(path: string, replace = false) {
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const PageFallback = () => (
  <div role="status" aria-label="Loading" className="flex h-full items-center justify-center">
    <Loader2 className="size-5 animate-spin text-muted-foreground" />
  </div>
);

export function App() {
  const {
    page: currentPage,
    sessionId: currentSessionId,
    dashboardId: currentDashboardId,
    builderSessionId: currentBuilderSessionId,
  } = useSyncExternalStore(subscribe, getRouteSnapshot);

  useEffect(preloadPages, []);

  const navigate = useCallback((page: Page) => {
    pushPath(page === "debug" ? "/" : `/${page}`);
  }, []);

  const selectSession = useCallback((id: string) => {
    pushPath(`/debug/${id}`);
  }, []);

  // A brand-new chat skips loading a session that doesn't exist yet; any later visit loads it.
  const [newSessionId, setNewSessionId] = useState<string | null>(null);
  const startNewSession = useCallback((replace = false) => {
    const id = crypto.randomUUID();
    setNewSessionId(id);
    pushPath(`/debug/${id}`, replace);
  }, []);
  useEffect(() => {
    if (newSessionId && currentSessionId !== newSessionId) setNewSessionId(null);
  }, [currentSessionId, newSessionId]);

  const newSession = useCallback(() => startNewSession(), [startNewSession]);

  // A bare /debug (or /) visit gets its id before paint, so Debug mounts once.
  const needsSessionId = currentPage === "debug" && !currentSessionId;
  useLayoutEffect(() => {
    if (needsSessionId) startNewSession(true);
  }, [needsSessionId, startNewSession]);

  const selectDashboard = useCallback((id: string) => {
    pushPath(`/dashboard/${id}`);
  }, []);

  const newDashboard = useCallback(() => {
    pushPath(`/dashboard/${crypto.randomUUID()}`);
  }, []);

  const closeBuilderChat = useCallback(() => {
    pushPath("/monitors");
  }, []);

  const openBuilderChat = useCallback((sessionId: string) => {
    pushPath(`/monitors/chat/${sessionId}`);
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <Shell
        sidebar={
          <AppSidebar
            currentPage={currentPage}
            onNavigate={navigate}
            currentSessionId={currentSessionId}
            onSelectSession={selectSession}
            onNewSession={newSession}
            currentDashboardId={currentDashboardId}
            onSelectDashboard={selectDashboard}
            onNewDashboard={newDashboard}
          />
        }
      >
        <ErrorBoundary resetKey={window.location.pathname}>
        <Suspense fallback={<PageFallback />}>
          {Dashboard && currentPage === "dashboard" && (
            <Dashboard
              key={currentDashboardId ?? "default"}
              dashboardId={currentDashboardId}
              onSelectDashboard={selectDashboard}
            />
          )}
          {currentPage === "debug" && currentSessionId && (
            <Debug key={currentSessionId} sessionId={currentSessionId} isNew={currentSessionId === newSessionId} onDeleted={() => startNewSession(true)} />
          )}
          {Monitors && currentPage === "monitors" && (
            <Monitors
              builderSessionId={currentBuilderSessionId ?? undefined}
              onNavigate={selectSession}
              onOpenBuilder={openBuilderChat}
              onCloseBuilder={closeBuilderChat}
            />
          )}
          {currentPage === "settings" && <Settings />}
        </Suspense>
        </ErrorBoundary>
      </Shell>
      {IS_IOS && <CopyFromComputerDialog />}
      <AlertToaster />
      <Toaster
        position="bottom-center"
        theme="dark"
        style={
          {
            "--normal-bg": "var(--foreground)",
            "--normal-text": "var(--background)",
            "--normal-border": "var(--foreground)",
            "--border-radius": "var(--radius)",
          } as CSSProperties
        }
      />
    </TooltipProvider>
  );
}

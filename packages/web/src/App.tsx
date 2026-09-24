import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";
import { FEATURES } from "@tracer-sh/shared";
import { Shell } from "./components/layout/Shell";
import { Sidebar, type Page } from "./components/layout/Sidebar";
import { Spinner } from "./components/ui/Spinner";

const Debug = lazy(() => import("./pages/Debug").then(m => ({ default: m.Debug })));
const Settings = lazy(() => import("./pages/Settings").then(m => ({ default: m.Settings })));
const Dashboard = FEATURES.dashboards
  ? lazy(() => import("./pages/Dashboard").then(m => ({ default: m.Dashboard })))
  : null;
const Monitors = FEATURES.monitors
  ? lazy(() => import("./pages/Monitors").then(m => ({ default: m.Monitors })))
  : null;

const validPages = new Set<string>([
  "debug",
  "settings",
  ...(FEATURES.dashboards ? ["dashboard"] : []),
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

// Stable reference for useSyncExternalStore — must return the same object for
// identical URLs to avoid infinite re-renders.
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

function pushPath(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const PageFallback = () => <Spinner size="lg" centered />;

export function App() {
  const {
    page: currentPage,
    sessionId: currentSessionId,
    dashboardId: currentDashboardId,
    builderSessionId: currentBuilderSessionId,
  } = useSyncExternalStore(subscribe, getRouteSnapshot);

  const navigate = useCallback((page: Page) => {
    pushPath(page === "debug" ? "/" : `/${page}`);
  }, []);

  const selectSession = useCallback((id: string) => {
    pushPath(`/debug/${id}`);
  }, []);

  const newSession = useCallback(() => {
    pushPath("/debug");
  }, []);

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
    <Shell
      sidebar={
        <Sidebar
          currentPage={currentPage}
          onNavigate={navigate}
          currentSessionId={currentSessionId}
          onSelectSession={selectSession}
          onNewSession={newSession}
          currentDashboardId={currentDashboardId}
          onSelectDashboard={selectDashboard}
          onNewDashboard={newDashboard}
          currentBuilderSessionId={currentBuilderSessionId}
          onSelectBuilderChat={openBuilderChat}
        />
      }
    >
      <Suspense fallback={<PageFallback />}>
        {Dashboard && currentPage === "dashboard" && (
          <Dashboard
            key={currentDashboardId ?? "default"}
            dashboardId={currentDashboardId}
            onSelectDashboard={selectDashboard}
          />
        )}
        {currentPage === "debug" && (
          <Debug
            key={currentSessionId ?? "new"}
            sessionId={currentSessionId}
            onSessionChange={selectSession}
          />
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
    </Shell>
  );
}

import { router } from "./trpc.js";
import { providerRouter } from "./routers/provider.router.js";
import { settingsRouter } from "./routers/settings.router.js";
import { memoryRouter } from "./routers/memory.router.js";
import { sessionsRouter } from "./routers/sessions.router.js";
import { widgetsRouter } from "./routers/widgets.router.js";
import { dashboardsRouter } from "./routers/dashboards.router.js";
import { monitorsRouter } from "./routers/monitors.router.js";
import { monitorAlertsRouter } from "./routers/monitor-alerts.router.js";
import { updateRouter } from "./routers/update.router.js";

export const appRouter = router({
  provider: providerRouter,
  settings: settingsRouter,
  memory: memoryRouter,
  sessions: sessionsRouter,
  widgets: widgetsRouter,
  dashboards: dashboardsRouter,
  monitors: monitorsRouter,
  monitorAlerts: monitorAlertsRouter,
  update: updateRouter,
});

export type AppRouter = typeof appRouter;

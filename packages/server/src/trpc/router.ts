import { FEATURES } from "@tracer-sh/shared";
import { router } from "./trpc.js";
import { providerRouter } from "./routers/provider.router.js";
import { settingsRouter } from "./routers/settings.router.js";
import { memoryRouter } from "./routers/memory.router.js";
import { sessionsRouter } from "./routers/sessions.router.js";
import { widgetsRouter } from "./routers/widgets.router.js";
import { dashboardsRouter } from "./routers/dashboards.router.js";
import { monitorsRouter } from "./routers/monitors.router.js";
import { updateRouter } from "./routers/update.router.js";
import { integrationsRouter } from "./routers/integrations.router.js";
import { skillRouter } from "./routers/skill.router.js";
import { transferRouter } from "./routers/transfer.router.js";

// The web client types reference these routers, so the type stays; a disabled feature has no procedures at runtime.
const whenEnabled = <T>(enabled: boolean, routes: T): T => (enabled ? routes : router({}) as unknown as T);

export const appRouter = router({
  provider: providerRouter,
  integrations: integrationsRouter,
  settings: settingsRouter,
  memory: memoryRouter,
  sessions: sessionsRouter,
  widgets: whenEnabled(FEATURES.dashboards, widgetsRouter),
  dashboards: whenEnabled(FEATURES.dashboards, dashboardsRouter),
  monitors: monitorsRouter,
  update: updateRouter,
  skill: skillRouter,
  transfer: transferRouter,
});

export type AppRouter = typeof appRouter;

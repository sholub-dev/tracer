export const DEFAULT_SESSION_TITLE = "New chat";
export const DEFAULT_CHAT_MODE = "direct" as const;

export const SESSION_PREFIX = {
  DASHBOARD: "__dashboard__",
  MONITORS: "__monitors__",
} as const;

export function dashboardSessionId(dashboardId: string): string {
  return `${SESSION_PREFIX.DASHBOARD}:${dashboardId}`;
}

/** All known LLM model IDs — shared between server (resolution) and web (pricing). */
export const KNOWN_MODEL_IDS = [
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "claude-haiku-4-5-20251001",
] as const;
export type KnownModelId = (typeof KNOWN_MODEL_IDS)[number];

export const DEFAULT_SESSION_TITLE = "New chat";
export const DEFAULT_CHAT_MODE = "direct" as const;

export const SESSION_PREFIX = {
  DASHBOARD: "__dashboard__",
  MONITORS: "__monitors__",
} as const;

export const SESSION_KIND = {
  IMPORTED: "imported",
} as const;
export type SessionKind = (typeof SESSION_KIND)[keyof typeof SESSION_KIND];

export function dashboardSessionId(dashboardId: string): string {
  return `${SESSION_PREFIX.DASHBOARD}:${dashboardId}`;
}

import { SESSION_KIND } from "@tracer-sh/shared";

// Keys are also saved sidebar filter values, so they must stay stable.
export type SessionKindKey = "chat" | "alert" | "api" | "imported";

const KEYS: Record<string, SessionKindKey> = {
  [SESSION_KIND.MONITOR]: "alert",
  [SESSION_KIND.API]: "api",
  [SESSION_KIND.IMPORTED]: "imported",
};

const LABELS: Record<SessionKindKey, string> = { chat: "Chat", alert: "Alert", api: "API", imported: "Imported" };

export const sessionKindKey = (kind: string | null | undefined): SessionKindKey => KEYS[kind ?? ""] ?? "chat";
export const sessionKindLabel = (kind: string | null | undefined) => LABELS[sessionKindKey(kind)];

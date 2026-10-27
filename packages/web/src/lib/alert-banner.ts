import { SESSION_KIND } from "@tracer-sh/shared";

export interface SessionRow {
  id: string;
  kind: string | null;
  status: string;
}

export interface BannerChanges {
  /** Sessions whose run just started: show the investigating banner. */
  show: string[];
  /** Shown sessions whose run is over: show the result. */
  update: string[];
  /** Shown sessions that left the list: drop their banner. */
  gone: string[];
  /** The ids to treat as seen after this list. */
  known: Set<string>;
}

/**
 * Decides which alert banners to show or update for a new session list.
 * `known` is null before the first list, which only seeds it. A new session that is still idle stays
 * unseen, because a monitor's session is created idle a moment before its run starts streaming.
 */
export function detectBanners(known: ReadonlySet<string> | null, shown: ReadonlySet<string>, list: SessionRow[], activeId: string | null): BannerChanges {
  const next = new Set(known);
  const changes: BannerChanges = { show: [], update: [], gone: [...shown].filter((id) => !list.some((s) => s.id === id)), known: next };
  for (const s of list) {
    if (known && !known.has(s.id) && s.kind === SESSION_KIND.MONITOR && s.status === "streaming" && s.id !== activeId) changes.show.push(s.id);
    if (known && shown.has(s.id) && s.status !== "streaming" && s.id !== activeId) changes.update.push(s.id);
    if (!known || known.has(s.id) || s.status !== "idle") next.add(s.id);
  }
  return changes;
}

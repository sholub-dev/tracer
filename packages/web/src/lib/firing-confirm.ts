export interface PendingFiring {
  id: string;
  monitorName: string;
  detail: string;
  /** Time left when the server sent the list; the server's clock, so a client clock offset does not matter. */
  remainingMs: number;
}

/** Whole seconds left, counting down locally from the time the list arrived. */
export function remainingSeconds(remainingMs: number, receivedAt: number, now: number): number {
  return Math.max(0, Math.ceil((remainingMs - (now - receivedAt)) / 1000));
}

/** Which banners to open and close for a new list: one per firing, closed once the server no longer lists it. */
export function diffBanners(shown: ReadonlySet<string>, list: readonly PendingFiring[]): { show: PendingFiring[]; gone: string[] } {
  const listed = new Set(list.map((f) => f.id));
  return { show: list.filter((f) => !shown.has(f.id)), gone: [...shown].filter((id) => !listed.has(id)) };
}

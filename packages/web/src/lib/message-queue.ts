import { isSteered } from "@tracer-sh/shared";

/** After a reply: a steered message the server kept (`knownIds`) stays in the thread; one that is missing is sent again as a normal message. */
export function splitSteered<T extends { id: string }>(steered: T[], knownIds: ReadonlySet<string>): { kept: T[]; late: T[] } {
  return { kept: steered.filter((m) => knownIds.has(m.id)), late: steered.filter((m) => !knownIds.has(m.id)) };
}

/**
 * A queued message goes out once the reply ends cleanly. After a stop or an error it waits for the user,
 * and while the composer is locked it waits too.
 */
export function canSendQueued({ status, held, queued, locked }: { status: string; held: boolean; queued: number; locked: boolean }): boolean {
  return status === "ready" && !held && !locked && queued > 0;
}


/** The last message of the turn: a steered message that trails the reply does not start a new turn. */
export function lastTurnMessage<T extends { metadata?: unknown }>(messages: T[]): T | undefined {
  return messages.findLast((m) => !isSteered(m));
}

/** Adds kept steered messages to the thread unless adopted saved history already holds them. */
export function appendKept<T extends { id: string }>(thread: T[], kept: T[]): T[] {
  const present = new Set(thread.map((m) => m.id));
  const fresh = kept.filter((m) => !present.has(m.id));
  return fresh.length ? [...thread, ...fresh] : thread;
}

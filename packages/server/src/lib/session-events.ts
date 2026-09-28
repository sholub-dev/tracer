import { EventEmitter } from "node:events";

/** Fires with a session id whenever its chat_sessions row is created, changed (status/title/order) or deleted. */
export const sessionEvents = new EventEmitter<{ changed: [id: string] }>();
sessionEvents.setMaxListeners(0);

export function sessionChanged(...ids: string[]): void {
  for (const id of ids) sessionEvents.emit("changed", id);
}

import { createFeed } from "./feed.js";

const feed = createFeed<string>();

/** Notifies with a session id whenever its chat_sessions row is created, changed (status/title/order) or deleted, and after each model call it pays for. */
export function sessionChanged(...ids: string[]): void {
  for (const id of ids) feed.emit(id);
}

/** Yields each changed session id until `signal` aborts. */
export const sessionChanges = feed.subscribe;

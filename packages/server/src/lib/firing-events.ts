import { createFeed } from "./feed.js";

const feed = createFeed<void>([undefined]);

/** Tells every open subscription that the set of firings waiting for a Yes or No changed. */
export function pendingFiringsChanged(): void {
  feed.emit();
}

/** Yields once on subscribing, then after each change, until `signal` aborts. */
export const pendingFiringChanges = feed.subscribe;

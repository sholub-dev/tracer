import type { Db } from "../db/driver.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import type { SteerState } from "../agents/steer.js";

interface ActiveStream {
  broadcaster: StreamBroadcaster;
  controller: AbortController; // server-owned, for explicit stop
  steer: SteerState;
}

export interface Context {
  db: Db;
  providers: ProviderRegistry;
  activeStreams: Map<string, ActiveStream>;
  /** Set by the in-app server only: a copy replaces the whole local database. */
  receivesCopy?: boolean;
  /** True for a caller that holds the session secret, and for the in-app client. Opens the copy procedures. */
  isOwner?: boolean;
}

// The HTTP guard marks a request that carries the session secret. No header or body can set the mark.
const ownerRequests = new WeakSet<Request>();
export const markOwnerRequest = (req: Request): void => { ownerRequests.add(req); };
export const isOwnerRequest = (req: Request): boolean => ownerRequests.has(req);

export function createContext(deps: { db: Db; providers: ProviderRegistry }): Context {
  return {
    db: deps.db,
    providers: deps.providers,
    activeStreams: new Map(),
  };
}

import type { Db } from "../db/driver.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StreamBroadcaster } from "../lib/stream-broadcaster.js";
import type { SteerState } from "../agents/steer.js";

export interface ActiveStream {
  broadcaster: StreamBroadcaster;
  controller: AbortController; // server-owned, for explicit stop
  steer: SteerState;
}

export interface Context {
  db: Db;
  providers: ProviderRegistry;
  activeStreams: Map<string, ActiveStream>;
}

export function createContext(deps: { db: Db; providers: ProviderRegistry }): Context {
  return {
    db: deps.db,
    providers: deps.providers,
    activeStreams: new Map(),
  };
}

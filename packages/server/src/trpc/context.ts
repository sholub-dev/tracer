import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StreamBroadcaster } from "../lib/stream-broadcaster.js";

export interface ActiveStream {
  broadcaster: StreamBroadcaster;
  controller: AbortController; // server-owned, for explicit stop
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

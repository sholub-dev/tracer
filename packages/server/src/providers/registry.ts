import type { IProvider, ProviderStatus } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { providerConfigs } from "../db/schema.js";
import { CONFIG } from "../config.js";

export type ProviderFactory = (config: Record<string, string>) => IProvider;

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password";
  /** Defaults to true. When false, the field can be left empty. */
  required?: boolean;
}

export interface ProviderMeta {
  label: string;
  configFields: ConfigField[];
}

interface FactoryEntry {
  factory: ProviderFactory;
  meta: ProviderMeta;
}

export class ProviderRegistry {
  private providers = new Map<string, IProvider>();
  private factories = new Map<string, FactoryEntry>();

  registerFactory(type: string, factory: ProviderFactory, meta: ProviderMeta): void {
    this.factories.set(type, { factory, meta });
  }

  getRegisteredTypes(): Array<{ type: string } & ProviderMeta> {
    return Array.from(this.factories.entries()).map(([type, entry]) => ({
      type,
      ...entry.meta,
    }));
  }

  createFromFactory(type: string, config: Record<string, string>): IProvider {
    const entry = this.factories.get(type);
    if (!entry) throw new Error(`No factory registered for provider type: ${type}`);
    return entry.factory(config);
  }

  register(provider: IProvider): void {
    this.providers.set(provider.name, provider);
  }

  async unregister(name: string): Promise<void> {
    const provider = this.providers.get(name);
    if (provider) {
      await provider.dispose();
      this.providers.delete(name);
    }
  }

  getProvider(name: string): IProvider | undefined {
    return this.providers.get(name);
  }

  getAllProviders(): IProvider[] {
    return Array.from(this.providers.values());
  }

  getStatus(): ProviderStatus[] {
    return this.getAllProviders().map((p) => ({
      name: p.name,
      type: p.type,
      connected: p.connected,
      lastChecked: p.lastChecked,
    }));
  }

  private lastReconnectAt = new Map<string, number>();

  /** Pings each provider that is not connected, at most once per cooldown. A failed ping does not throw. */
  async reconnectDisconnected(): Promise<void> {
    const now = Date.now();
    const due = this.getAllProviders().filter((p) => {
      if ((p.connected && !p.idle) || now - (this.lastReconnectAt.get(p.name) ?? -Infinity) < CONFIG.providerReconnectCooldownMs) return false;
      this.lastReconnectAt.set(p.name, now);
      return true;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, CONFIG.providerReconnectWaitMs); });
    const pings = Promise.all(due.map((p) => p.ping().catch(() => {})));
    await Promise.race([pings, limit]).finally(() => clearTimeout(timer));
  }

  /** Replaces every configured provider with a fresh one from the stored settings, e.g. after a sync changed them. */
  reloadFromDb(db: Db): Promise<void> {
    return this.load(db, true);
  }

  initializeFromDb(db: Db): Promise<void> {
    return this.load(db, false);
  }

  /**
   * Resolves when the stored providers are registered and their first connection checks ended.
   * A status read before that reports a provider that is still loading as not connected.
   * The wait has a limit, so a check that does not end cannot block the readers.
   */
  whenLoaded(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, CONFIG.providerLoadWaitMs); });
    return Promise.race([this.loading, limit]).finally(() => clearTimeout(timer));
  }

  private loading: Promise<void> = Promise.resolve();

  private load(db: Db, replace: boolean): Promise<void> {
    const done = this.registerFromDb(db, replace).then(async (providers) => {
      // In parallel: a slow source does not delay the others.
      await Promise.all(providers.map((provider) => provider.initialize().catch(() => {
        console.warn(`DB provider "${provider.type}" failed to initialize, but was registered.`);
      })));
    });
    this.loading = done.catch(() => {});
    return done;
  }

  private async registerFromDb(db: Db, replace: boolean): Promise<IProvider[]> {
    if (replace) {
      for (const provider of this.getAllProviders()) {
        if (this.factories.has(provider.type)) await this.unregister(provider.name);
      }
    }
    const rows = await db.select().from(providerConfigs).all();
    const added: IProvider[] = [];
    for (const row of rows) {
      if (this.providers.has(row.type)) continue;

      let config: Record<string, string>;
      try {
        config = JSON.parse(row.config) as Record<string, string>;
      } catch {
        console.warn(`[registry] Corrupted config for provider "${row.type}", skipping`);
        continue;
      }

      const entry = this.factories.get(row.type);
      if (!entry) continue;

      const provider = entry.factory(config);
      this.register(provider);
      added.push(provider);
    }
    return added;
  }
}

import type { IProvider, ProviderStatus } from "@tracer-sh/shared";
import type { Db } from "../db/client.js";
import { providerConfigs } from "../db/schema.js";

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

  async initializeFromDb(db: Db): Promise<void> {
    const rows = db.select().from(providerConfigs).all();

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

      try {
        await provider.initialize();
      } catch {
        console.warn(`DB provider "${row.type}" failed to initialize, but was registered.`);
      }
    }
  }
}

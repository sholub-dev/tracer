import type {
  IProvider,
  PingResult,
} from "@tracer-sh/shared";

export abstract class BaseProvider implements IProvider {
  abstract readonly type: string;

  connected = false;
  lastChecked: string | null = null;

  /** Proves the credentials work; throws the reason when they do not. */
  protected abstract probe(): Promise<void>;
  abstract executeRawQuery(query: string): Promise<unknown>;

  async ping(): Promise<PingResult> {
    try {
      await this.probe();
      this.connected = true;
      this.lastChecked = new Date().toISOString();
      return { ok: true };
    } catch (err) {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async initialize(): Promise<void> {
    const result = await this.ping();
    if (!result.ok) throw new Error(result.error);
  }

  async dispose(): Promise<void> {
    this.connected = false;
  }
}

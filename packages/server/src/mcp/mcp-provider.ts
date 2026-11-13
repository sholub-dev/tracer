import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { BaseProvider } from "../providers/base.provider.js";
import type { McpServerEntry } from "./definitions.js";
import { CONFIG } from "../config.js";
import { withTimeout } from "../lib/with-timeout.js";

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

export class McpProvider extends BaseProvider {
  readonly type: string;

  private client: McpClient | null = null;
  protected cachedTools: Record<string, any> | null = null;
  private lastReconnectAttempt = 0;
  private starting: Promise<void> | null = null;
  private discovering: Promise<Record<string, any>> | null = null;
  private liveTools: Record<string, any> = {};
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  /** Why the last start or ping failed; the reconnect wait reports it instead of a bare "not connected". */
  private lastError: Error | undefined;
  private disposed = false;
  idle = false;

  constructor(
    private readonly server: McpServerEntry,
    protected readonly config: Record<string, string>,
    providerType: string,
  ) {
    super();
    this.type = providerType;
  }

  /** Spawns the subprocess when none runs, then lists its tools: this also refills the cache that invalidateTools() cleared. */
  protected async probe(): Promise<void> {
    if (!this.client) {
      const now = Date.now();
      if (now - this.lastReconnectAttempt < CONFIG.mcpReconnectCooldownMs) throw this.lastError ?? new Error("No MCP client connected");
      this.lastReconnectAttempt = now;
    }
    try {
      if (!this.client) await this.createClient();
      await withTimeout(this.discoverTools(), CONFIG.mcpPingTimeoutMs, "MCP ping");
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      // A dead or hung subprocess stays set otherwise and every later ping fails on it. Not awaited: a hung close must not hang the ping.
      if (this.inFlight === 0) void this.closeClient();
      throw err;
    }
    this.armIdleClose();
  }

  override async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    await this.closeClient();
    this.cachedTools = null;
    await super.dispose();
  }

  /** Return cached tools synchronously, or null if not yet discovered. */
  getCachedTools(): Record<string, any> | null {
    return this.cachedTools;
  }

  /** Tool calls running now, a call that is stuck included. */
  get callsRunning(): number {
    return this.inFlight;
  }

  /** Invalidate cached tools and the client; the next ping respawns it. */
  invalidateTools(): void {
    this.cachedTools = null;
    // Not connected, so the next run pings it and respawns the client; a connected provider is skipped.
    this.connected = false;
    this.closeClient().catch(() => {});
  }

  async executeRawQuery(_query: string): Promise<unknown> {
    throw new Error("Raw queries are not supported by MCP-backed providers.");
  }

  // ── Private ──

  /** Restarts the idle countdown; the subprocess closes when it ends with no tool call running. */
  private armIdleClose(): void {
    this.idle = false;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inFlight > 0) return this.armIdleClose();
      this.idle = true;
      void this.closeClient();
    }, CONFIG.mcpIdleCloseMs);
    this.idleTimer.unref?.();
  }

  private createClient(): Promise<void> {
    this.starting ??= this.spawnClient().then(async (client) => {
      // A dispose during the spawn found no client to close, so this one would outlive the provider.
      if (this.disposed) {
        await client.close().catch(() => {});
        throw new Error("The provider was disposed during startup");
      }
      this.client = client;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async spawnClient(): Promise<McpClient> {
    const { server } = this;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "",
    };
    for (const [configKey, envVar] of Object.entries(server.envMapping)) {
      if (this.config[configKey]) {
        env[envVar] = this.config[configKey];
      }
    }
    for (const key of server.passthroughEnv ?? []) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    const transport = new Experimental_StdioMCPTransport({
      command: "npx",
      args: ["-y", `${server.package}@${server.version}`],
      env,
    });

    const clientPromise = createMCPClient({ transport });
    try {
      return await withTimeout(clientPromise, CONFIG.mcpInitTimeoutMs, `MCP server ${server.package} startup`);
    } catch (err) {
      // The client may still come up after the timeout; close it so its process does not leak.
      clientPromise.then((c) => c.close()).catch(() => {});
      throw err;
    }
  }

  /** One discovery at a time: concurrent callers (ping, chat start) share the same request. */
  private discoverTools(): Promise<Record<string, any>> {
    this.discovering ??= this.discoverAllTools()
      .then((tools) => { this.cachedTools = tools; return tools; })
      .finally(() => { this.discovering = null; });
    return this.discovering;
  }

  private async discoverAllTools(): Promise<Record<string, any>> {
    const tools = (await this.client?.tools()) ?? {};
    const wrapped: Record<string, any> = {};
    for (const [name, t] of Object.entries<any>(tools)) {
      this.liveTools[name] = t;
      wrapped[name] = typeof t.execute === "function" ? { ...t, execute: (...args: unknown[]) => this.running(() => this.execute(name, args)) } : t;
    }
    return wrapped;
  }

  /** After an idle close the cached tools stay, so a call respawns the client and runs on the fresh tool. */
  private async execute(name: string, args: unknown[]): Promise<unknown> {
    if (!this.client) {
      await this.createClient();
      try {
        await withTimeout(this.discoverTools(), CONFIG.mcpInitTimeoutMs, "MCP tool discovery");
      } catch (err) {
        // A hung subprocess would block every later call the same way.
        void this.closeClient();
        throw err;
      }
    }
    return this.liveTools[name].execute(...args);
  }

  /** A tool call keeps the client open while it runs and restarts the idle countdown when it ends. */
  private async running<T>(call: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      return await call();
    } finally {
      this.inFlight--;
      this.armIdleClose();
    }
  }

  /** Ignores errors: the process may already be dead. */
  private async closeClient(): Promise<void> {
    const old = this.client;
    this.client = null;
    await old?.close().catch(() => {});
  }
}

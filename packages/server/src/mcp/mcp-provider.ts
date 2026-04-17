import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type {
  OkoError,
  OkoLogEntry,
  OkoTransaction,
  PingResult,
  TimeRange,
  ChatToolWriter,
  ChatToolMemoryContext,
  ProviderToolKit,
} from "@oko/shared";
import { BaseProvider } from "../providers/base.provider.js";
import type { McpServerDefinition, McpServerEntry } from "./definitions.js";
import { createMcpChatTools } from "./mcp-tools.js";
import { CONFIG } from "../config.js";

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

export class McpProvider extends BaseProvider {
  readonly name: string;
  readonly type: string;

  private clients: McpClient[] = [];
  protected cachedTools: Record<string, any> | null = null;
  private lastReconnectAttempt = 0;

  constructor(
    private readonly definition: McpServerDefinition,
    protected readonly config: Record<string, string>,
    providerType: string,
  ) {
    super();
    this.name = providerType;
    this.type = providerType;
  }

  async initialize(): Promise<void> {
    try {
      await this.createClients();
      // Eagerly discover tools to validate the connections
      const tools = await this.discoverAllTools();
      this.cachedTools = tools;
      this.connected = true;
      this.lastChecked = new Date().toISOString();
      console.log(
        `[mcp] ${this.definition.label} connected (${this.clients.length} server(s)), ${Object.keys(tools).length} tools discovered`,
      );
    } catch (err) {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      console.warn(`[mcp] ${this.definition.label} failed to initialize:`, err);
      throw err;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      // Always restart clients to pick up fresh credentials
      await this.closeAllClients();
      this.cachedTools = null;
      await this.createClients();
      const tools = await this.discoverAllTools();
      this.cachedTools = tools;
      this.connected = true;
      this.lastChecked = new Date().toISOString();
      return true;
    } catch {
      await this.closeAllClients();
      this.cachedTools = null;
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return false;
    }
  }

  async ping(): Promise<PingResult> {
    if (this.clients.length === 0) {
      const now = Date.now();
      if (now - this.lastReconnectAttempt < CONFIG.mcpReconnectCooldownMs) {
        return { ok: false, error: "No MCP clients connected" };
      }
      this.lastReconnectAttempt = now;
      try { await this.createClients(); } catch { /* fall through */ }
      if (this.clients.length === 0) {
        return { ok: false, error: "No MCP clients connected" };
      }
    }
    try {
      await Promise.race([
        Promise.all(this.clients.map((c) => c.tools())),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Ping timed out")), CONFIG.mcpPingTimeoutMs),
        ),
      ]);
      this.connected = true;
      this.lastChecked = new Date().toISOString();
      return { ok: true };
    } catch (err) {
      this.connected = false;
      this.lastChecked = new Date().toISOString();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async dispose(): Promise<void> {
    await this.closeAllClients();
    this.cachedTools = null;
    this.connected = false;
  }

  /** Return cached tools synchronously, or null if not yet discovered. */
  getCachedTools(): Record<string, any> | null {
    return this.cachedTools;
  }

  /** Invalidate cached tools and clients — forces reconnection on next getMcpTools() call. */
  invalidateTools(): void {
    this.cachedTools = null;
    // Close existing clients in the background (best-effort)
    this.closeAllClients().catch(() => {});
  }

  /** Get cached MCP tools (AI SDK-compatible). Lazily rediscovers if cache is empty. */
  async getMcpTools(): Promise<Record<string, any>> {
    if (this.cachedTools) return this.cachedTools;
    try {
      if (this.clients.length === 0) {
        await this.createClients();
      }
      const tools = await this.discoverAllTools();
      this.cachedTools = tools;
      return tools;
    } catch (err) {
      await this.closeAllClients();
      this.cachedTools = null;
      throw err;
    }
  }

  getChatTools(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
  }): ProviderToolKit {
    return createMcpChatTools(this, this.definition, options);
  }

  // Structured data methods — MCP-backed providers expose data through tool calls, not these typed APIs.
  async getErrors(_timeRange: TimeRange): Promise<OkoError[]> {
    return [];
  }
  async getTransactions(_timeRange: TimeRange): Promise<OkoTransaction[]> {
    return [];
  }
  async getLogs(_timeRange: TimeRange, _filter?: string): Promise<OkoLogEntry[]> {
    return [];
  }
  async executeRawQuery(_query: string): Promise<unknown> {
    return { error: "Raw queries are not supported by MCP-backed providers." };
  }

  // ── Private ──

  /** Spawn MCP clients for all servers in parallel. */
  private async createClients(): Promise<void> {
    const entries = this.definition.servers;
    this.clients = await Promise.all(entries.map((entry) => this.spawnClient(entry)));
  }

  /** Spawn a single MCP client for one server entry with timeout. */
  private async spawnClient(entry: McpServerEntry): Promise<McpClient> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: process.env.NODE_ENV ?? "",
    };
    for (const [configKey, envVar] of Object.entries(entry.envMapping)) {
      if (this.config[configKey]) {
        env[envVar] = this.config[configKey];
      }
    }
    if (entry.passthroughEnv) {
      for (const key of entry.passthroughEnv) {
        if (process.env[key]) {
          env[key] = process.env[key]!;
        }
      }
    }

    // Prefer locally-installed (potentially patched) packages over npx downloads.
    const local = resolveLocalBin(entry.package);
    const command = local ? "node" : "npx";
    const args = local
      ? [local, ...(entry.args ?? [])]
      : ["-y", entry.package, ...(entry.args ?? [])];

    const transport = new Experimental_StdioMCPTransport({
      command,
      args,
      env,
    });

    const clientPromise = createMCPClient({ transport });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`MCP server ${entry.package} timed out after ${CONFIG.mcpInitTimeoutMs / 1000}s`)),
        CONFIG.mcpInitTimeoutMs,
      );
    });

    return Promise.race([clientPromise, timeoutPromise]);
  }

  /** Discover tools from all connected clients and merge into a single record. */
  private async discoverAllTools(): Promise<Record<string, any>> {
    const toolSets = await Promise.all(this.clients.map((c) => c.tools()));
    const merged: Record<string, any> = {};
    for (const tools of toolSets) {
      Object.assign(merged, tools);
    }
    return merged;
  }

  /** Close all clients, ignoring errors (processes may already be dead). */
  private async closeAllClients(): Promise<void> {
    await Promise.all(
      this.clients.map((c) => c.close().catch(() => {})),
    );
    this.clients = [];
  }
}

const require = createRequire(import.meta.url);

/** Resolve the bin entry of a locally-installed npm package, or null if not found. */
function resolveLocalBin(pkg: string): string | null {
  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const bin = pkgJson.bin;
    if (!bin) return null;
    const entry = typeof bin === "string" ? bin : Object.values(bin)[0] as string;
    if (!entry) return null;
    return resolve(dirname(pkgJsonPath), entry);
  } catch {
    return null;
  }
}

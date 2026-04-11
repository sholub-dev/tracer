/** Time range for queries */
export interface TimeRange {
  since: string;
  until?: string;
}

/** Normalized error from any provider */
export interface OkoError {
  id: string;
  appName: string;
  errorClass: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  transactionName: string;
  provider: string;
}

/** Normalized transaction from any provider */
export interface OkoTransaction {
  name: string;
  avgDuration: number;
  throughput: number;
  errorRate: number;
  provider: string;
}

/** Normalized log entry from any provider */
export interface OkoLogEntry {
  timestamp: string;
  level: string;
  message: string;
  attributes: Record<string, unknown>;
  provider: string;
}

/** Provider runtime status */
export interface ProviderStatus {
  name: string;
  type: string;
  connected: boolean;
  lastChecked: string | null;
}

/** Lightweight health-check result */
export interface PingResult {
  ok: boolean;
  error?: string;
}

/** Token usage breakdown from an LLM call. */
export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/** Minimal writer interface for streaming progress events to the client. */
export interface ChatToolWriter {
  write(part: Record<string, unknown>): void;
  sessionId?: string;
}

/** Memory context passed to provider chat tools. */
export interface ChatToolMemoryContext {
  toolName: string;
  existingMemories: Array<{ id: number; toolName: string; note: string | null }>;
}

/** Chat architecture mode. */
export type ChatMode = "orchestrator" | "direct";

/** Callback fired after a direct-mode chat session completes. */
export interface AfterCompleteParams {
  lastUserMessage: string;
  lastAssistantText: string;
  sessionId: string;
}

/** Tools and prompt fragments a provider contributes to chat */
export interface ProviderToolKit {
  tools: Record<string, unknown>;
  systemPrompt?: string;
  promptFragments?: string[];
  /** Override the main chat step limit (direct mode). */
  maxSteps?: number;
  /** Fired after the chat session completes (direct mode — e.g. memory agent). */
  afterComplete?: (params: AfterCompleteParams) => void;
}

/** Provider interface - all providers must implement this */
export interface IProvider {
  readonly name: string;
  readonly type: string;

  connected: boolean;
  lastChecked: string | null;

  initialize(): Promise<void>;
  testConnection(): Promise<boolean>;
  ping(): Promise<PingResult>;
  dispose(): Promise<void>;

  getErrors(timeRange: TimeRange): Promise<OkoError[]>;
  getTransactions(timeRange: TimeRange): Promise<OkoTransaction[]>;
  getLogs(timeRange: TimeRange, filter?: string): Promise<OkoLogEntry[]>;
  executeRawQuery(query: string): Promise<unknown>;

  /** Return chat tools and prompt fragments for this provider */
  getChatTools?(options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
    mode?: ChatMode;
  }): ProviderToolKit;
}

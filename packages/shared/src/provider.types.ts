/** Provider runtime status */
export interface ProviderStatus {
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

/** Memory context passed to provider chat tools. */
export interface ChatToolMemoryContext {
  toolName: string;
  existingMemories: Array<{ id: number; toolName: string; note: string | null }>;
  /** The notes the prompt carries; when absent, they are picked from `existingMemories`. */
  injected?: MemoryInjection;
}

/** The notes chosen for a prompt, and how many the budget left out. */
export interface MemoryInjection {
  notes: Array<{ id: number; toolName: string; note: string }>;
  omitted: number;
}

/**
 * Chat architecture mode.
 * - `direct`: one agent scoped to a single provider.
 * - `unified`: one agent holding every connected provider's query tools at once.
 */
export type ChatMode = "direct" | "unified";

/** Callback fired after a direct-mode chat session completes. */
export interface AfterCompleteParams {
  lastUserMessage: string;
  lastAssistantText: string;
  sessionId: string;
}

/** What a provider receives when chat asks for its tools. */
export interface ChatToolOptions {
  memoryContext?: ChatToolMemoryContext;
  db?: unknown;
  mode?: ChatMode;
}

/** Tools and prompt fragments a provider contributes to chat */
export interface ProviderToolKit {
  tools: Record<string, unknown>;
  systemPrompt?: string;
  promptFragments?: string[];
  /** Fired after the chat session completes (direct mode — e.g. memory agent). */
  afterComplete?: (params: AfterCompleteParams) => void;
}

/** Provider interface - all providers must implement this */
export interface IProvider {
  readonly type: string;

  connected: boolean;
  lastChecked: string | null;
  /** True while the provider holds no live connection on purpose; a ping reconnects it. */
  idle?: boolean;

  initialize(): Promise<void>;
  ping(): Promise<PingResult>;
  dispose(): Promise<void>;

  executeRawQuery(query: string): Promise<unknown>;

  /** Return chat tools and prompt fragments for this provider */
  getChatTools?(options: ChatToolOptions): ProviderToolKit;
}

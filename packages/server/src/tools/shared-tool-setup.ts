import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter, AfterCompleteParams, ChatMode } from "@oko/shared";
import { toolMemories } from "../db/schema.js";

export interface BaseToolSetup {
  tools: Record<string, unknown>;
  promptFragments: string[];
  systemPrompt?: string;
  maxSteps?: number;
  afterComplete?: (params: AfterCompleteParams) => void;
  connectedProviders: ReturnType<ProviderRegistry["getAllProviders"]>;
}

export function collectBaseTools(
  registry: ProviderRegistry,
  db: Db,
  writer?: StreamWriter,
  mode?: ChatMode,
  activeProvider?: string,
): BaseToolSetup {
  const memories = db.select().from(toolMemories).all();
  const tools: Record<string, unknown> = {};
  const promptFragments: string[] = [];
  const systemPrompts: string[] = [];
  let maxSteps: number | undefined;
  const afterCompleteCallbacks: Array<(params: AfterCompleteParams) => void> = [];
  let connectedProviders = registry.getAllProviders().filter((p) => p.connected);

  // Filter to active provider if specified (exclusive toggle)
  if (activeProvider) {
    connectedProviders = connectedProviders.filter((p) => p.type === activeProvider);
  }

  // Collect tools from all connected providers
  for (const provider of connectedProviders) {
    if (provider.getChatTools) {
      try {
        const kit = provider.getChatTools({
          writer,
          memoryContext: {
            toolName: provider.type,
            existingMemories: memories.filter((m) => m.toolName === provider.type),
          },
          db,
          mode,
        });
        Object.assign(tools, kit.tools);
        promptFragments.push(...(kit.promptFragments ?? []));
        // Collect direct-mode fields from all providers
        if (kit.systemPrompt) systemPrompts.push(kit.systemPrompt);
        if (kit.maxSteps && (!maxSteps || kit.maxSteps > maxSteps)) maxSteps = kit.maxSteps;
        if (kit.afterComplete) afterCompleteCallbacks.push(kit.afterComplete);
      } catch (err) {
        console.warn(`[chat-tools] Failed to load tools for ${provider.name}:`, err);
      }
    }
  }

  // Merge system prompts from all providers (direct mode)
  const systemPrompt = systemPrompts.length > 0 ? systemPrompts.join("\n\n---\n\n") : undefined;

  // Chain afterComplete callbacks so all providers run their post-processing
  const afterComplete = afterCompleteCallbacks.length > 0
    ? (params: AfterCompleteParams) => { for (const cb of afterCompleteCallbacks) cb(params); }
    : undefined;

  return { tools, promptFragments, systemPrompt, maxSteps, afterComplete, connectedProviders };
}

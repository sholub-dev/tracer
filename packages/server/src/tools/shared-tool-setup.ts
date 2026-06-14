import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter, AfterCompleteParams, ChatMode } from "@tracer-sh/shared";
import { toolMemories } from "../db/schema.js";
import { buildUnifiedModePrompt } from "../lib/shared-prompts.js";
import { injectMemories } from "../agents/chat/sub-agent.js";
import { getJiraChatTools } from "../integrations/jira/tools.js";
import { DEFAULTS } from "../config.js";

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
  includeIntegrations = false,
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

  // Jira is a non-observability integration: when enabled (chat only — not the dashboard/monitor
  // builders) its tools are always-on, independent of the active-provider filter above, so they're
  // available alongside whatever provider is selected.
  const jiraKit = includeIntegrations ? getJiraChatTools(db) : null;
  if (jiraKit) {
    Object.assign(tools, jiraKit.tools);
    promptFragments.push(jiraKit.promptFragment);
  }

  // System prompt assembly:
  // - unified: ONE coherent prompt — shared intro/discipline/analysis once + each provider's
  //   role-less fragment (begin_analysis already comes from the merged direct tools).
  // - direct: a single connected provider supplies its own complete system prompt.
  let systemPrompt =
    mode === "unified"
      ? (promptFragments.length > 0
          ? injectMemories(
              buildUnifiedModePrompt(promptFragments, maxSteps ?? DEFAULTS.directModeMaxSteps),
              // Unified holds every connected provider's tools, so surface all their memories
              // (direct mode injects the active provider's memories via its own systemPrompt).
              {
                toolName: "unified",
                existingMemories: memories.filter((m) => connectedProviders.some((p) => p.type === m.toolName)),
              },
            )
          : undefined)
      : (systemPrompts.length > 0 ? systemPrompts.join("\n\n---\n\n") : undefined);

  // In direct mode the model uses this systemPrompt and ignores promptFragments, so the Jira
  // guidance must be appended here. (Unified already folded it via buildUnifiedModePrompt; the
  // no-provider case falls back to base-agent's prompt + promptFragments, which includes it.)
  if (mode !== "unified" && jiraKit && systemPrompt) {
    systemPrompt += "\n\n" + jiraKit.promptFragment;
  }

  // Chain afterComplete callbacks so all providers run their post-processing
  const afterComplete = afterCompleteCallbacks.length > 0
    ? (params: AfterCompleteParams) => { for (const cb of afterCompleteCallbacks) cb(params); }
    : undefined;

  return { tools, promptFragments, systemPrompt, maxSteps, afterComplete, connectedProviders };
}

import type { Db } from "../db/driver.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter, AfterCompleteParams, ChatMode } from "@tracer-sh/shared";
import { toolMemories } from "../db/schema.js";
import { applyStepBudget, buildNoProviderPrompt, buildUnifiedModePrompt } from "../lib/shared-prompts.js";
import { injectMemories } from "../agents/chat/sub-agent.js";
import { getJiraChatTools } from "../integrations/jira/tools.js";
import { DEFAULTS, SETTINGS_KEYS } from "../config.js";
import { readAppSetting } from "../db/config-reader.js";

export interface BaseToolSetup {
  tools: Record<string, unknown>;
  promptFragments: string[];
  systemPrompt?: string;
  /** The run's step limit and the number its prompt names. */
  maxSteps?: number;
  afterComplete?: (params: AfterCompleteParams) => void;
  connectedProviders: ReturnType<ProviderRegistry["getAllProviders"]>;
  /** Types of the providers connected for this run. */
  providerTypes?: string[];
}

export async function collectBaseTools(
  registry: ProviderRegistry,
  db: Db,
  writer?: StreamWriter,
  mode?: ChatMode,
  activeProvider?: string,
  includeIntegrations = false,
): Promise<BaseToolSetup> {
  const memories = await db.select().from(toolMemories).all();
  const tools: Record<string, unknown> = {};
  const promptFragments: string[] = [];
  const systemPrompts: string[] = [];
  const maxSteps = (await readAppSetting<number>(db, SETTINGS_KEYS.directModeMaxSteps)) ?? DEFAULTS.directModeMaxSteps;
  const afterCompleteCallbacks: Array<(params: AfterCompleteParams) => void> = [];
  await registry.whenLoaded();
  await registry.reconnectDisconnected();
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
        if (kit.afterComplete) afterCompleteCallbacks.push(kit.afterComplete);
      } catch (err) {
        console.warn(`[chat-tools] Failed to load tools for ${provider.name}:`, err);
      }
    }
  }

  const providerFragmentCount = promptFragments.length;
  const hasProviderTools = Object.keys(tools).length > 0;

  // Jira is a non-observability integration: when enabled (chat only — not the dashboard/monitor
  // builders) its tools are always-on, independent of the active-provider filter above, so they're
  // available alongside whatever provider is selected.
  const jiraKit = includeIntegrations ? await getJiraChatTools(db) : null;
  if (jiraKit) {
    Object.assign(tools, jiraKit.tools);
    promptFragments.push(jiraKit.promptFragment);
  }

  // System prompt assembly:
  // - unified: ONE coherent prompt — shared intro/discipline/analysis once + each provider's
  //   role-less fragment (begin_analysis already comes from the merged direct tools).
  // - direct: a single connected provider supplies its own complete system prompt.
  let systemPrompt: string | undefined;
  if (!hasProviderTools) {
    // Without a provider tool the observability prompt would describe tools the run does not have.
    if (jiraKit) systemPrompt = buildNoProviderPrompt([jiraKit.promptFragment]);
  } else if (mode === "unified") {
    systemPrompt = providerFragmentCount > 0
      ? injectMemories(
          buildUnifiedModePrompt(promptFragments, maxSteps),
          // Unified holds every connected provider's tools, so surface all their memories
          // (direct mode injects the active provider's memories via its own systemPrompt).
          {
            toolName: "unified",
            existingMemories: memories.filter((m) => connectedProviders.some((p) => p.type === m.toolName)),
          },
        )
      : undefined;
  } else if (systemPrompts.length > 0) {
    // Provider prompts are built at load, before the setting is known.
    systemPrompt = applyStepBudget(systemPrompts.join("\n\n---\n\n"), maxSteps);
    if (jiraKit) systemPrompt += "\n\n" + jiraKit.promptFragment;
  }

  // Chain afterComplete callbacks so all providers run their post-processing
  const afterComplete = afterCompleteCallbacks.length > 0
    ? (params: AfterCompleteParams) => { for (const cb of afterCompleteCallbacks) cb(params); }
    : undefined;

  return { tools, promptFragments, systemPrompt, maxSteps, afterComplete, connectedProviders, providerTypes: connectedProviders.map((p) => p.type) };
}

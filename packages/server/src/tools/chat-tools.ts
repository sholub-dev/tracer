import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter, ChatMode } from "@tracer-sh/shared";
import { DEFAULT_CHAT_MODE } from "@tracer-sh/shared";
import { readAppSetting } from "../db/config-reader.js";
import { collectBaseTools, type BaseToolSetup } from "./shared-tool-setup.js";

type ChatToolsResult = Omit<BaseToolSetup, "connectedProviders" | "tools"> & {
  tools: Record<string, unknown> | undefined;
};

export function collectChatTools(registry: ProviderRegistry, db: Db, writer?: StreamWriter, activeProvider?: string): ChatToolsResult {
  const mode = readAppSetting<ChatMode>(db, "chat_mode") ?? DEFAULT_CHAT_MODE;
  const { tools, promptFragments, systemPrompt, maxSteps, afterComplete, connectedProviders } =
    collectBaseTools(registry, db, writer, mode, activeProvider);

  // Debug chat returns undefined tools when no providers are connected,
  // so server.ts can show a "no providers configured" fallback prompt.
  if (connectedProviders.length === 0) {
    return { tools: undefined, promptFragments: [] };
  }

  return { tools, promptFragments, systemPrompt, maxSteps, afterComplete };
}

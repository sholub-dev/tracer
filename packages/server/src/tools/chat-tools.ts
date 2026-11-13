import type { Db } from "../db/driver.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatMode } from "@tracer-sh/shared";
import { setTimerTool } from "./timer-tool.js";
import { reportFindingTool } from "./finding-tool.js";
import { askUserTool } from "./ask-tool.js";
import { collectBaseTools, type BaseToolSetup } from "./shared-tool-setup.js";

type ChatToolsResult = Omit<BaseToolSetup, "connectedProviders" | "tools"> & {
  tools: Record<string, unknown> | undefined;
};

export async function collectChatTools(
  registry: ProviderRegistry,
  db: Db,
  sessionId: string | undefined,
  mode: ChatMode,
  activeProvider?: string,
): Promise<ChatToolsResult> {
  const { tools, promptFragments, systemPrompt, maxSteps, afterComplete, connectedProviders, providerTypes } =
    await collectBaseTools(registry, db, sessionId, mode, activeProvider, true);

  // Debug chat returns undefined tools when no providers are connected,
  // so server.ts can show a "no providers configured" fallback prompt.
  // Keep tools if an always-on integration (e.g. Jira) contributed any.
  if (connectedProviders.length === 0 && Object.keys(tools).length === 0) {
    return { tools: undefined, promptFragments: [] };
  }

  return { tools, promptFragments, systemPrompt, maxSteps, afterComplete, providerTypes };
}

/** The provider tools plus the tools every chat session gets. Run extras override tools of the same name. */
export function withSessionTools(tools: Record<string, unknown>, db: Db, sessionId: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...tools, set_timer: setTimerTool(db, sessionId), report_finding: reportFindingTool(), ask_user: askUserTool(), ...extras };
}

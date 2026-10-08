import type { Db } from "../db/driver.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter, ChatMode, SessionKind } from "@tracer-sh/shared";
import { DEFAULT_CHAT_MODE, SESSION_KIND } from "@tracer-sh/shared";
import { setTimerTool } from "./timer-tool.js";
import { reportFindingTool } from "./finding-tool.js";
import { collectBaseTools, type BaseToolSetup } from "./shared-tool-setup.js";

type ChatToolsResult = Omit<BaseToolSetup, "connectedProviders" | "tools"> & {
  tools: Record<string, unknown> | undefined;
};

export async function collectChatTools(
  registry: ProviderRegistry,
  db: Db,
  writer?: StreamWriter,
  activeProvider?: string,
  mode: ChatMode = DEFAULT_CHAT_MODE,
): Promise<ChatToolsResult> {
  const { tools, promptFragments, systemPrompt, maxSteps, afterComplete, connectedProviders, providerTypes } =
    await collectBaseTools(registry, db, writer, mode, activeProvider, true);

  // Debug chat returns undefined tools when no providers are connected,
  // so server.ts can show a "no providers configured" fallback prompt.
  // Keep tools if an always-on integration (e.g. Jira) contributed any.
  if (connectedProviders.length === 0 && (!tools || Object.keys(tools).length === 0)) {
    return { tools: undefined, promptFragments: [] };
  }

  return { tools, promptFragments, systemPrompt, maxSteps, afterComplete, providerTypes };
}

// Triage acts on New Relic issues in monitor runs, so the triage setting decides what gets closed.
// A run with no person present gets no other write tool that reaches outside its own scoped extras.
const UNATTENDED_DROPPED = new Set(["ack_nr_issue", "close_nr_issue", "add_jira_comment"]);

/** The provider tools plus the tools every chat session gets. `unattended` marks a run no person watches: monitor, API, wake-up or resumed run. */
export function withSessionTools(tools: Record<string, unknown>, db: Db, sessionId: string, kind?: SessionKind, extras: Record<string, unknown> = {}, unattended = false): Record<string, unknown> {
  const noHuman = unattended || kind === SESSION_KIND.MONITOR || kind === SESSION_KIND.API;
  const own = noHuman ? Object.fromEntries(Object.entries(tools).filter(([name]) => !UNATTENDED_DROPPED.has(name))) : tools;
  return { ...own, set_timer: setTimerTool(db, sessionId), report_finding: reportFindingTool(), ...extras };
}

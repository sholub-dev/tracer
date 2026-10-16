/**
 * GCP tool factories — builds MCP-wrapped tools and provider toolkit.
 */

import { z } from "zod";
import { jsonSchema, tool } from "ai";
import type { AfterCompleteParams, ChatToolMemoryContext } from "@tracer-sh/shared";
import {
  injectMemories,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import { capQuery } from "../../lib/messages-codec.js";
import type { Db } from "../../db/driver.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import type { McpProvider } from "../../mcp/mcp-provider.js";
import { formatGcpResult } from "./gcp-formatter.js";
import { extractMcpContent, isTransportError, detectTruncation } from "../../mcp/mcp-tools.js";
import { CONFIG } from "../../config.js";
import { getGcpAuth, clearGcpAuthCache, isReauthError } from "./gcp-auth.js";
import {
  gcpDirectModeSystemPrompt,
  buildProjectConstraint,
  buildGcpUnifiedFragment,
} from "./prompts.js";

export { buildGcpUnifiedFragment };

// ── Direct mode tool factory ──

// Adds the chart-title field to an MCP tool's schema; the field is dropped again before the call.
function withTitleField(schema: any) {
  const base = schema?.jsonSchema;
  if (!base?.properties || "title" in base.properties) return schema ?? z.object({});
  return jsonSchema({
    ...base,
    properties: { ...base.properties, title: { type: "string", description: 'Short chart title in plain words, e.g. "Checkout p95 latency"' } },
  });
}

/** Runs the call with a limit and the caller's abort. The race also ends a call that ignores the signal. */
async function withCallLimit<T>(call: (signal: AbortSignal) => Promise<T>, caller: AbortSignal | undefined, message: string, onLimit: () => void): Promise<T> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller!.reason);
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener("abort", onCallerAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DOMException(message, "TimeoutError");
      onLimit();
      controller.abort(err);
      reject(err);
    }, CONFIG.mcpToolCallTimeoutMs);
  });
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([call(controller.signal), limit, stopped]);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
    stopped.catch(() => {});
    limit.catch(() => {});
  }
}

export function createGcpDirectTools(
  provider: McpProvider,
  memoryContext?: ChatToolMemoryContext,
  db?: unknown,
  projectId?: string,
): { tools: Record<string, unknown>; systemPrompt: string; afterComplete: (params: AfterCompleteParams) => void } {
  const projectConstraint = buildProjectConstraint(projectId);

  const rawMcpTools = provider.getCachedTools();
  if (!rawMcpTools || Object.keys(rawMcpTools).length === 0) {
    return {
      tools: {},
      systemPrompt: "GCP MCP tools are not available. The provider may not be connected.",
      afterComplete: () => {},
    };
  }

  const collectedQueries: SubAgentQuery[] = [];
  const directTools: Record<string, unknown> = {};
  const noteReauth = (text: string) => {
    if (!isReauthError(text)) return;
    clearGcpAuthCache();
    provider.connected = false;
  };

  for (const [name, mcpTool] of Object.entries(rawMcpTools)) {
    const originalExecute = (mcpTool as any).execute.bind(mcpTool);
    const ownsTitle = "title" in ((mcpTool as any).inputSchema?.jsonSchema?.properties ?? {});

    directTools[name] = tool({
      description: (mcpTool as any).description ?? name,
      inputSchema: withTitleField((mcpTool as any).inputSchema),
      execute: async (rawInput: any, options?: { abortSignal?: AbortSignal }) => {
        const { title: _title, ...rest } = rawInput && typeof rawInput === "object" ? rawInput : ({} as Record<string, unknown>);
        const input = ownsTitle || !rawInput || typeof rawInput !== "object" ? rawInput : rest;
        const queryStr = typeof input === "string" ? input : JSON.stringify(input).slice(0, 500);

        const auth = await getGcpAuth();
        if (!auth.ok) {
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: auth.message } });
          return { error: auth.message };
        }

        // At the limit the stuck call still counts as running: it is not another call.
        let otherCalls: number | undefined;
        try {
          const timeoutMessage = `${name} timed out after ${CONFIG.mcpToolCallTimeoutMs / 1000}s. Narrow the filter or the time range, or try again.`;
          const result = await withCallLimit((signal) => originalExecute(input, { ...options, abortSignal: signal }), options?.abortSignal, timeoutMessage, () => { otherCalls = provider.callsRunning - 1; });
          const normalized = extractMcpContent(result);
          // MCP reports API failures as an isError result, not a thrown error.
          if ((result as { isError?: boolean } | null)?.isError) noteReauth(typeof normalized === "string" ? normalized : JSON.stringify(normalized));

          if (detectTruncation(normalized)) {
            const errorMsg =
              `The result exceeded the server's size limit. ` +
              `Reduce pageSize (use 5-10), add more specific filters, or request a shorter time range.`;
            collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: errorMsg } });
            return { error: errorMsg };
          }

          collectedQueries.push({ query: `${name}: ${queryStr}`, results: normalized });

          const markdown = formatGcpResult(name, normalized);
          return { parts: [capQuery({ type: "query" as const, query: `${name}: ${queryStr}`, results: normalized })], analysis: markdown };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: message } });
          // A call that hit the limit may be stuck in a hung subprocess. Closing the clients also kills the other running calls, so then only the next ping or run respawns them.
          if (isTransportError(err) || (err instanceof Error && err.name === "TimeoutError")) {
            if ((otherCalls ?? provider.callsRunning) <= 0) provider.invalidateTools();
            else provider.connected = false;
          }
          noteReauth(message);
          return { error: message };
        }
      },
      toModelOutput: ({ output }: { output: any }) => toolModelOutput(output),
    });
  }

  directTools[ANALYSIS_TOOL_NAME] = beginAnalysisTool;

  return {
    tools: directTools,
    systemPrompt: injectMemories(gcpDirectModeSystemPrompt + projectConstraint, memoryContext),
    afterComplete: buildAfterComplete({ providerType: "gcp", db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}

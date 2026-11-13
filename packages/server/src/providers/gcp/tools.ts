/**
 * GCP tool factories: wraps the MCP server's tools as direct-mode query tools.
 */

import { z } from "zod";
import { jsonSchema, tool } from "ai";
import type { ChatToolMemoryContext } from "@tracer-sh/shared";
import type { ProviderQuery } from "../../agents/chat/query-records.js";
import { capQuery } from "../../lib/messages-codec.js";
import { toolModelOutput, buildDirectTools, type DirectTools } from "../../tools/provider-tool-helpers.js";
import { abortAfter } from "../../lib/fetch-retry.js";
import type { McpProvider } from "../../mcp/mcp-provider.js";
import { formatGcpResult } from "./gcp-formatter.js";
import { extractMcpContent, isTransportError, mcpFailure } from "../../mcp/mcp-tools.js";
import { CONFIG } from "../../config.js";
import { getGcpAuth, clearGcpAuthCache, isReauthError } from "./gcp-auth.js";
import { gcpDirectModeSystemPrompt, buildProjectConstraint } from "./prompts.js";

// Adds the chart-title field to an MCP tool's schema; the field is dropped again before the call.
function withTitleField(schema: any) {
  const base = schema?.jsonSchema;
  if (!base?.properties || "title" in base.properties) return schema ?? z.object({});
  return jsonSchema({
    ...base,
    properties: { ...base.properties, title: { type: "string", description: "Plain title of what this query measures, read by a person and cited by the answer card." } },
  });
}

/** The server marks a cut result in its text. */
const detectTruncation = (text: string) => text.includes("truncated due to") && text.includes("character limit");

/** Runs the call with a limit and the caller's abort. The race also ends a call that ignores the signal. */
async function withCallLimit<T>(call: (signal: AbortSignal) => Promise<T>, caller: AbortSignal | undefined, message: string, onLimit: () => void): Promise<T> {
  if (caller?.aborted) throw caller.reason;
  const link = abortAfter(caller, CONFIG.mcpToolCallTimeoutMs, message, onLimit);
  try {
    return await Promise.race([call(link.signal), link.stopped]);
  } finally {
    link.clear();
  }
}

export function createGcpDirectTools(
  provider: McpProvider,
  memoryContext?: ChatToolMemoryContext,
  db?: unknown,
  projectId?: string,
): DirectTools {
  const rawMcpTools = provider.getCachedTools();
  if (!rawMcpTools || Object.keys(rawMcpTools).length === 0) {
    return {
      tools: {},
      systemPrompt: "GCP MCP tools are not available. The provider may not be connected.",
      afterComplete: () => {},
    };
  }

  const collectedQueries: ProviderQuery[] = [];
  const queryTools: Record<string, unknown> = {};
  const noteReauth = (text: string) => {
    if (!isReauthError(text)) return;
    clearGcpAuthCache();
    provider.connected = false;
  };

  for (const [name, mcpTool] of Object.entries(rawMcpTools)) {
    const originalExecute = (mcpTool as any).execute.bind(mcpTool);
    const ownsTitle = "title" in ((mcpTool as any).inputSchema?.jsonSchema?.properties ?? {});

    queryTools[name] = tool({
      description: (mcpTool as any).description ?? name,
      inputSchema: withTitleField((mcpTool as any).inputSchema),
      execute: async (rawInput: any, options?: { abortSignal?: AbortSignal }) => {
        const { title: _title, ...rest } = rawInput && typeof rawInput === "object" ? rawInput : ({} as Record<string, unknown>);
        const input = ownsTitle || !rawInput || typeof rawInput !== "object" ? rawInput : rest;
        const queryStr = typeof input === "string" ? input : JSON.stringify(input).slice(0, 500);

        const label = `${name}: ${queryStr}`;
        const fail = (message: string) => {
          collectedQueries.push({ query: label, results: { error: message } });
          return { error: message };
        };

        const auth = await getGcpAuth();
        if (!auth.ok) return fail(auth.message);

        // At the limit the stuck call still counts as running: it is not another call.
        let otherCalls: number | undefined;
        try {
          const timeoutMessage = `${name} timed out after ${CONFIG.mcpToolCallTimeoutMs / 1000}s. Narrow the filter or the time range, or try again.`;
          const result = await withCallLimit((signal) => originalExecute(input, { ...options, abortSignal: signal }), options?.abortSignal, timeoutMessage, () => { otherCalls = provider.callsRunning - 1; });
          const content = extractMcpContent(result);
          const failure = mcpFailure(result, content);
          if (failure) {
            noteReauth(content.text);
            return fail(failure);
          }
          if (detectTruncation(content.text)) {
            return fail("The result exceeded the server's size limit. Add more specific filters, request a shorter time range, or lower pageSize, then retry.");
          }

          collectedQueries.push({ query: label, results: content.value });
          return { parts: [capQuery({ type: "query" as const, query: label, results: content.value })], analysis: formatGcpResult(name, content.value) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A call that hit the limit may be stuck in a hung subprocess. Closing the client also kills the other running calls, so then only the next ping or run respawns it.
          if (isTransportError(err) || (err instanceof Error && err.name === "TimeoutError")) {
            if ((otherCalls ?? provider.callsRunning) <= 0) provider.invalidateTools();
            else provider.connected = false;
          }
          noteReauth(message);
          return fail(message);
        }
      },
      toModelOutput: ({ output }: { output: any }) => toolModelOutput(output),
    });
  }

  return buildDirectTools({
    providerType: "gcp",
    tools: queryTools,
    prompt: gcpDirectModeSystemPrompt + buildProjectConstraint(projectId),
    collectedQueries,
    memoryContext,
    db,
  });
}

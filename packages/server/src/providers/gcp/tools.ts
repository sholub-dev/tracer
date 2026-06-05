/**
 * GCP tool factories — builds MCP-wrapped tools and provider toolkit.
 */

import { z } from "zod";
import { tool } from "ai";
import type { AfterCompleteParams, ChatToolMemoryContext, ChatToolWriter } from "@tracer-sh/shared";
import {
  injectMemories,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import type { Db } from "../../db/client.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import type { McpProvider } from "../../mcp/mcp-provider.js";
import { formatGcpResult } from "./gcp-formatter.js";
import { extractMcpContent, isTransportError, detectTruncation } from "../../mcp/mcp-tools.js";
import { getGcpAuth } from "./gcp-auth.js";
import {
  GCP_DIRECT_MODE_MAX_STEPS,
  gcpDirectModeSystemPrompt,
  buildProjectConstraint,
  buildGcpUnifiedFragment,
} from "./prompts.js";

export { GCP_DIRECT_MODE_MAX_STEPS, buildGcpUnifiedFragment };

// ── Direct mode tool factory ──

export function createGcpDirectTools(
  provider: McpProvider,
  memoryContext?: ChatToolMemoryContext,
  writer?: ChatToolWriter,
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

  for (const [name, mcpTool] of Object.entries(rawMcpTools)) {
    const originalExecute = (mcpTool as any).execute.bind(mcpTool);

    directTools[name] = tool({
      description: (mcpTool as any).description ?? name,
      inputSchema: (mcpTool as any).inputSchema ?? z.object({}),
      execute: async (input: any, { toolCallId }: { toolCallId: string }) => {
        const queryStr = typeof input === "string" ? input : JSON.stringify(input).slice(0, 500);

        const auth = await getGcpAuth();
        if (!auth.ok) {
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: auth.message } });
          return { error: auth.message };
        }

        try {
          const result = await originalExecute(input);
          const normalized = extractMcpContent(result);

          if (detectTruncation(normalized)) {
            const errorMsg =
              `The result exceeded the server's size limit. ` +
              `Reduce pageSize (use 5-10), add more specific filters, or request a shorter time range.`;
            collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: errorMsg } });
            return { error: errorMsg };
          }

          collectedQueries.push({ query: `${name}: ${queryStr}`, results: normalized });

          writer?.write({
            type: "data-provider-part",
            data: { toolCallId, part: { type: "query", query: `${name}: ${queryStr}`, results: normalized } },
          });

          const markdown = formatGcpResult(name, normalized);
          return { parts: [{ type: "query" as const, query: `${name}: ${queryStr}`, results: normalized }], analysis: markdown };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: message } });
          if (isTransportError(err)) provider.invalidateTools();
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

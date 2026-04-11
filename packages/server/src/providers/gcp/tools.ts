/**
 * GCP tool factories — builds MCP-wrapped tools and provider toolkit.
 */

import { z } from "zod";
import { tool } from "ai";
import type { AfterCompleteParams, ChatToolMemoryContext, ChatToolWriter, ProviderToolKit } from "@oko/shared";
import {
  runSubAgent,
  injectMemories,
  subAgentModelOutput,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import type { Db } from "../../db/client.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import type { McpProvider } from "../../mcp/mcp-provider.js";
import { wrapGcpMcpTools, formatGcpResult } from "./gcp-formatter.js";
import { extractMcpContent, isTransportError, detectTruncation } from "../../mcp/mcp-tools.js";
import { getGcpAuth } from "./gcp-auth.js";
import {
  GCP_DIRECT_MODE_MAX_STEPS,
  gcpSystemPrompt,
  gcpDirectModeSystemPrompt,
  directSystemPrompt,
  investigateSystemPrompt,
  buildProjectConstraint,
} from "./prompts.js";

export { GCP_DIRECT_MODE_MAX_STEPS };

// ── Orchestrator tool factory ──

export function createGcpTools(
  provider: McpProvider,
  memoryContext?: ChatToolMemoryContext,
  writer?: ChatToolWriter,
  db?: unknown,
  projectId?: string,
): ProviderToolKit {
  const projectConstraint = buildProjectConstraint(projectId);
  const tools = {
    gcloud: tool({
      description:
        "Investigate Google Cloud observability data by describing WHAT you want to find out. A sub-agent will autonomously query Cloud Logging, Cloud Monitoring, Cloud Trace, and Error Reporting via MCP tools, handle errors, and return analysis + raw results. Results are AUTOMATICALLY displayed to the user in a rich UI — NEVER repeat or reformat them in your text response.",
      inputSchema: z.object({
        task: z.string().describe(
          "A clear description of what to investigate (e.g. 'show recent errors for my Cloud Run service', 'investigate why error rate spiked in project my-project')",
        ),
        directive: z.enum(["DIRECT", "INVESTIGATE"]).describe(
          "DIRECT for simple lookups/lists/describes. INVESTIGATE for root-cause analysis, multi-step debugging.",
        ),
      }),
      execute: async ({ task, directive }, { toolCallId, abortSignal }) => {
        if (!db) {
          return { error: "Database not available for model resolution." };
        }

        const auth = await getGcpAuth();
        if (!auth.ok) return { error: auth.message };

        let mcpTools: Record<string, any>;
        try {
          mcpTools = await provider.getMcpTools();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Failed to discover GCP MCP tools: ${msg}` };
        }

        if (!mcpTools || Object.keys(mcpTools).length === 0) {
          return { error: "No GCP MCP tools available from the server." };
        }

        const { wrappedTools, mcpToolNames, collectedQueries } = wrapGcpMcpTools(mcpTools, provider);

        const systemPrompt = (directive === "DIRECT" ? directSystemPrompt : investigateSystemPrompt) + projectConstraint;

        return runSubAgent({
          providerType: "gcp",
          db: db!,
          systemPrompt,
          task,
          toolCallId,
          queryTools: wrappedTools,
          queryToolNames: mcpToolNames,
          collectedQueries,
          memoryContext,
          writer,
          sessionId: writer?.sessionId,
          abortSignal,
        });
      },
      toModelOutput: ({ output }) => subAgentModelOutput(output),
    }),
  };

  return {
    tools,
    promptFragments: [gcpSystemPrompt],
  };
}

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

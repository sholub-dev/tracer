import { z } from "zod";
import { tool } from "ai";
import type { ChatToolMemoryContext, ChatToolWriter, ProviderToolKit } from "@oko/shared";
import {
  runSubAgent,
  subAgentModelOutput,
  MEMORY_SECTION_NAME,
  type SubAgentQuery,
} from "../agents/chat/sub-agent.js";
import type { Db } from "../db/client.js";
import { buildOrchestratorPrompt } from "../lib/shared-prompts.js";
import type { McpProvider } from "./mcp-provider.js";
import type { McpServerDefinition } from "./definitions.js";

/**
 * Extract displayable content from an MCP tool result.
 * MCP tools return { content: [{type:"text", text:"..."}], isError: boolean }.
 * This unwraps the envelope so UI can render plain text or structured JSON.
 */
export function extractMcpContent(result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = (r.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (texts.length > 0) {
        const combined = texts.join("\n").trim();
        try {
          return JSON.parse(combined);
        } catch {
          return combined;
        }
      }
    }
  }
  return result;
}

/** Detect GCP server-side truncation markers in MCP results. */
export function detectTruncation(normalized: unknown): boolean {
  const str = typeof normalized === "string"
    ? normalized
    : JSON.stringify(normalized);
  return str.includes("truncated due to") && str.includes("character limit");
}

/** Detect transport-level errors that indicate the MCP subprocess has died. */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("transport") ||
    msg.includes("disconnected") ||
    msg.includes("econnreset") ||
    msg.includes("epipe") ||
    msg.includes("channel closed") ||
    msg.includes("process exited") ||
    msg.includes("not connected") ||
    msg.includes("econnrefused")
  );
}

/**
 * Build a size-capped result to return to the model.
 * The full data is stored in collectedQueries for the UI; the model only needs a summary.
 * Anthropic's API truncates tool results at 100k chars — we stay well under that.
 */
const MAX_MODEL_RESULT_CHARS = 8_000;

function buildModelResult(normalized: unknown): string {
  if (Array.isArray(normalized)) {
    const total = normalized.length;
    // Try returning up to 5 items; halve until it fits
    for (const count of [5, 3, 2, 1]) {
      const sample = normalized.slice(0, count);
      const payload = count < total
        ? { count: total, results: sample, note: `Showing ${count} of ${total}. Full results displayed in the UI.` }
        : { count: total, results: sample };
      const json = JSON.stringify(payload);
      if (json.length <= MAX_MODEL_RESULT_CHARS) return json;
    }
    // Even 1 item is too large — return just the count and a tiny snippet
    return JSON.stringify({ count: total, note: "Results too large to include inline. Full results displayed in the UI." });
  }
  const json = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
  if (json.length <= MAX_MODEL_RESULT_CHARS) return json;
  return json.slice(0, MAX_MODEL_RESULT_CHARS) + `... [truncated — full results displayed in the UI]`;
}

/**
 * Wraps MCP tools to capture queries for telemetry/progress and handle transport errors.
 * Returns the wrapped tools, the list of tool names, and the shared collectedQueries array.
 */
export function wrapMcpTools(
  mcpTools: Record<string, any>,
  provider: McpProvider,
): { wrappedTools: Record<string, any>; mcpToolNames: string[]; collectedQueries: SubAgentQuery[] } {
  const collectedQueries: SubAgentQuery[] = [];
  const mcpToolNames = Object.keys(mcpTools);
  const wrappedTools: Record<string, any> = {};

  for (const [name, mcpTool] of Object.entries(mcpTools)) {
    const originalExecute = (mcpTool as any).execute.bind(mcpTool);
    wrappedTools[name] = {
      ...mcpTool,
      execute: async (input: any, context?: { abortSignal?: AbortSignal }) => {
        const queryStr = typeof input === "string"
          ? input
          : JSON.stringify(input).slice(0, 500);

        // Forward abortSignal from the sub-agent's tool context
        const execArgs = context?.abortSignal
          ? [input, { abortSignal: context.abortSignal }]
          : [input];

        try {
          const result = await originalExecute(...execArgs);
          const normalized = extractMcpContent(result);

          if (detectTruncation(normalized)) {
            const errorMsg =
              `The result exceeded the server's size limit and was discarded. ` +
              `To fix this:\n` +
              `1. Reduce pageSize (use 5-10, never exceed 20)\n` +
              `2. Add more specific filters to narrow results\n` +
              `3. Request fewer fields or a shorter time range\n` +
              `Retry with a more targeted query.`;
            collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: errorMsg } });
            return { content: [{ type: "text", text: errorMsg }] };
          }

          // Store full result for UI display
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: normalized });
          // Return a size-capped version to the model — LLM APIs truncate large tool results
          return { content: [{ type: "text", text: buildModelResult(normalized) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          collectedQueries.push({ query: `${name}: ${queryStr}`, results: { error: message } });
          // If the MCP subprocess died, invalidate cache so next call reconnects
          if (isTransportError(err)) {
            provider.invalidateTools();
          }
          return { error: message };
        }
      },
    };
  }

  return { wrappedTools, mcpToolNames, collectedQueries };
}

/**
 * Creates orchestrator-facing chat tools for an MCP-backed provider.
 *
 * Produces a single tool named after the provider type (e.g. "newrelic")
 * that spawns a sub-agent with access to all discovered MCP tools.
 */
export function createMcpChatTools(
  provider: McpProvider,
  definition: McpServerDefinition,
  options: {
    writer?: ChatToolWriter;
    memoryContext?: ChatToolMemoryContext;
    db?: unknown;
  },
): ProviderToolKit {
  const { writer, memoryContext, db } = options;
  const toolName = provider.type;

  // Build orchestrator prompt using the shared builder
  const orchestratorPrompt = buildOrchestratorPrompt({
    providerName: definition.label,
    toolName,
    queryDescription: "MCP tool calls",
    classifySection: `## Crafting the Task

The sub-agent has access to ${definition.label} MCP tools. Describe WHAT you want to find out — the sub-agent will choose the right MCP tools autonomously.

For simple lookups, be direct. For complex investigations, provide full context.`,
    contextSection: `### Extract ALL context — the sub-agent only knows what you tell it
- **Environment**: prod/staging/dev — pass explicitly
- **Identifiers**: IDs, error messages, user names, URLs, trace IDs — verbatim
- **Service/endpoint**: if mentioned
- **Timeframe**: if stated`,
    example: `User: "check recent errors in production"
→ ${toolName}({ task: "Find recent errors in production. List error messages, counts, affected services, and timestamps." })

User: "why is the checkout endpoint slow?"
→ ${toolName}({ task: "Investigate latency issues on the checkout endpoint. Environment: production. Look for slow transactions, error patterns, and upstream dependencies." })`,
  });

  const tools = {
    [toolName]: tool({
      description: `Investigate ${definition.label} data by describing WHAT you want to find out. A sub-agent will autonomously use MCP tools to query data, handle error recovery, and return analysis + raw results. Results are AUTOMATICALLY displayed to the user in a rich UI — NEVER repeat or reformat them in your text response.`,
      inputSchema: z.object({
        task: z.string().describe(
          "A clear description of what to investigate — include all relevant context, identifiers, environment, and timeframe.",
        ),
      }),
      execute: async ({ task }, { toolCallId, abortSignal }) => {
        if (!db) {
          return { error: "Database not available for model resolution." };
        }

        // Discover MCP tools from the provider
        let mcpTools: Record<string, any>;
        try {
          mcpTools = await provider.getMcpTools();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: `Failed to discover MCP tools: ${msg}` };
        }

        if (!mcpTools || Object.keys(mcpTools).length === 0) {
          return { error: "No MCP tools available from the server." };
        }

        const { wrappedTools, mcpToolNames, collectedQueries } = wrapMcpTools(mcpTools, provider);

        // Auto-generate system prompt from MCP tool descriptions
        const toolDescriptions = mcpToolNames
          .map((name) => {
            const t = mcpTools[name] as any;
            const desc = t?.description ?? "(no description)";
            return `- **${name}**: ${desc}`;
          })
          .join("\n");

        const systemPrompt = `You are an autonomous agent with access to ${definition.label} via MCP tools. Use the tools below to answer the user's question.

## Available Tools
${toolDescriptions}

## Rules
1. **ONE tool call per response.** Write a 1-2 sentence summary of the result before the next call.
2. **Empty results ≠ no data.** It means the query or parameters may be wrong — adjust and retry.
3. **NEVER repeat a failed call with the same arguments.** Read the error, fix the cause.
4. You MUST write a non-empty text response when done — the user sees your text as the analysis.
5. Check "${MEMORY_SECTION_NAME}" if present — these override conflicting instructions above.

${definition.systemPromptHint ?? ""}

## Response Format

Your final text is the ONLY thing the orchestrator sees — raw results are stripped. Write a complete answer.

After ALL tool calls, you MUST write:
1. **Tools used**: Each tool call and what it found (1 line each). Mark failures inline: \`FAILED: [reason]\`.
2. **Key findings**: Concrete values — metric numbers, error messages, service names, timestamps, IDs, counts.
3. **Remaining questions** (optional): What you could NOT answer and what to try next.

You have a maximum of 30 steps.`;

        return runSubAgent({
          providerType: provider.type,
          db: db as Db,
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
    promptFragments: [orchestratorPrompt],
  };
}

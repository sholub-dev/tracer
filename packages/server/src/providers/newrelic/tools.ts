/**
 * New Relic tool factories — builds execute_nrql tool and provider toolkit.
 */

import { z } from "zod";
import { tool, type Tool } from "ai";
import type { NewRelicProvider } from "./newrelic.provider.js";
import { formatTimestamps, type AfterCompleteParams, type ChatToolMemoryContext, type ChatToolWriter } from "@tracer-sh/shared";
import {
  injectMemories,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import type { Db } from "../../db/driver.js";
import { getTimezone } from "../../lib/current-context.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import { formatNrqlCsv, sanitizeNrqlRows } from "./nrql-formatter.js";
import {
  NR_DIRECT_MODE_MAX_STEPS,
  directModeSystemPrompt,
  nrUnifiedFragment,
} from "./prompts.js";

export { NR_DIRECT_MODE_MAX_STEPS, nrUnifiedFragment };

// ── Shared tool builder ──

export function withTimezone(query: string, timezone: string): string {
  return /\bWITH\s+TIMEZONE\b/i.test(query) || /^\s*SHOW\b/i.test(query) ? query : `${query.trim().replace(/;$/, "")} WITH TIMEZONE '${timezone}'`;
}

function buildExecuteNrqlTool(
  provider: NewRelicProvider,
  collectedQueries: SubAgentQuery[],
  writer?: ChatToolWriter,
  db?: Db,
) {
  return tool({
    description: "Execute a NRQL query against New Relic.",
    inputSchema: z.object({
      query: z.string().describe("The NRQL query to execute"),
      title: z.string().optional().describe("Short chart title in plain words, e.g. \"Checkout p95 latency\""),
    }),
    execute: async ({ query }, { toolCallId }) => {
      try {
        const timezone = await getTimezone(db);
        const raw = await provider.executeRawQuery(withTimezone(query, timezone));
        const cleaned = sanitizeNrqlRows(raw as Record<string, unknown>[]);
        collectedQueries.push({ query, results: cleaned });

        writer?.write({
          type: "data-provider-part",
          data: { toolCallId, part: { type: "query", query, results: cleaned } },
        });

        const formatted = formatTimestamps(raw, timezone);
        const csv = formatNrqlCsv(formatted as Record<string, unknown>[], query);
        return { parts: [{ type: "query" as const, query, results: cleaned }], analysis: csv };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        collectedQueries.push({ query, results: { error: message } });
        return { error: message };
      }
    },
    toModelOutput: ({ output }) => toolModelOutput(output),
  });
}

const ISSUE_LOOKBACK_HOURS = 6;
const ISSUE_STATES = ["CREATED", "ACTIVATED", "DEACTIVATED", "CLOSED"] as const;

function buildListIssuesTool(provider: NewRelicProvider) {
  return tool({
    description: "List New Relic alert issues with their state, title, condition and incident ids. It covers only the last sinceHours hours (default 6), not all time. Pass a larger sinceHours to look further back. The result has truncated: true when more issues exist than were read.",
    inputSchema: z.object({
      states: z.array(z.enum(ISSUE_STATES)).optional().describe("Keep only these states. Omit for all states."),
      issueIds: z.array(z.string()).optional().describe("Only these issue ids"),
      policyIds: z.array(z.number()).optional().describe("Only issues of these alert policy ids"),
      conditionIds: z.array(z.number()).optional().describe("Only issues of these alert condition ids"),
      sinceHours: z.number().positive().optional().describe(`How far back to look, in hours. Default ${ISSUE_LOOKBACK_HOURS}.`),
    }),
    execute: async ({ states, issueIds, policyIds, conditionIds, sinceHours }) => {
      try {
        const filter = {
          ...(issueIds?.length ? { ids: issueIds } : {}),
          ...(policyIds?.length ? { policyIds } : {}),
          ...(conditionIds?.length ? { conditionIds } : {}),
        };
        const now = Date.now();
        const hours = sinceHours ?? ISSUE_LOOKBACK_HOURS;
        const { issues, truncated } = await provider.aiIssuesPage(filter, now - hours * 3_600_000, now);
        return {
          issues: issues
            .filter((i) => !states?.length || states.includes(i.state))
            .map((i) => ({ issueId: i.issueId, state: i.state, title: i.title?.[0] ?? null, conditionName: i.conditionName?.[0] ?? null, incidentIds: i.incidentIds ?? [] })),
          sinceHours: hours,
          truncated,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });
}

export function buildIssueActionTool(description: string, run: (issueId: string) => Promise<{ ok: true } | { error: string }>): Tool {
  return tool({
    description,
    inputSchema: z.object({ issueId: z.string().describe("The New Relic issue id, from list_nr_issues") }),
    execute: ({ issueId }) => run(issueId),
  });
}

export function buildNewRelicIssueTools(provider: NewRelicProvider): Record<"list_nr_issues" | "ack_nr_issue" | "close_nr_issue", Tool> {
  return {
    list_nr_issues: buildListIssuesTool(provider),
    ack_nr_issue: buildIssueActionTool(
      "Acknowledge an issue in New Relic. Use it only when the user asks. State the action and its result in the answer.",
      (id) => provider.ackIssue(id),
    ),
    close_nr_issue: buildIssueActionTool(
      "Close an issue in New Relic. Use it only when the user asks. State the action and its result in the answer.",
      (id) => provider.resolveIssue(id),
    ),
  };
}

// ── Tool factories ──

export function createNewRelicDirectTools(
  provider: NewRelicProvider,
  memoryContext?: ChatToolMemoryContext,
  writer?: ChatToolWriter,
  db?: unknown,
): { tools: Record<string, unknown>; systemPrompt: string; afterComplete: (params: AfterCompleteParams) => void } {
  const collectedQueries: SubAgentQuery[] = [];

  return {
    tools: {
      execute_nrql: buildExecuteNrqlTool(provider, collectedQueries, writer, db as Db | undefined),
      ...buildNewRelicIssueTools(provider),
      [ANALYSIS_TOOL_NAME]: beginAnalysisTool,
    },
    systemPrompt: injectMemories(directModeSystemPrompt, memoryContext),
    afterComplete: buildAfterComplete({ providerType: "newrelic", db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}


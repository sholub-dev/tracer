/**
 * New Relic tool factories — builds execute_nrql tool and provider toolkit.
 */

import { z } from "zod";
import { tool, type Tool } from "ai";
import type { NewRelicProvider } from "./newrelic.provider.js";
import type { AiIssue } from "./nerdgraph.client.js";
import { formatTimestamps, type AfterCompleteParams, type ChatToolMemoryContext } from "@tracer-sh/shared";
import {
  injectMemories,
  type SubAgentQuery,
} from "../../agents/chat/sub-agent.js";
import type { Db } from "../../db/driver.js";
import { capQuery } from "../../lib/messages-codec.js";
import { getTimezone } from "../../lib/current-context.js";
import { toolModelOutput, buildAfterComplete } from "../../tools/provider-tool-helpers.js";
import { beginAnalysisTool, ANALYSIS_TOOL_NAME } from "../../tools/analysis-tool.js";
import { withFixHint } from "./nrql-errors.js";
import { formatNrqlCsv, parseFacetNames, sanitizeNrqlRows, stripStrings } from "./nrql-formatter.js";
import {
  directModeSystemPrompt,
  nrUnifiedFragment,
} from "./prompts.js";

export { nrUnifiedFragment };

// ── Shared tool builder ──

export function withTimezone(query: string, timezone: string): string {
  return /\bWITH\s+TIMEZONE\b/i.test(query) || /^\s*SHOW\b/i.test(query) ? query : `${query.trim().replace(/;$/, "")} WITH TIMEZONE '${timezone}'`;
}

function lacksSince(query: string): boolean {
  const q = stripStrings(query) ?? "";
  return !/\bSINCE\b/i.test(q) && !/^\s*SHOW\b/i.test(q) && !/\bkeyset\s*\(/i.test(q);
}

// NRQL takes its clauses in any order, so a WHERE can follow FACET and a SELECT can follow FROM.
const CLAUSE = /\b(SELECT|WHERE|FACET|TIMESERIES|LIMIT|ORDER\s+BY|COMPARE\s+WITH|SLIDE\s+BY|SINCE|UNTIL|WITH\s+TIMEZONE)\b/gi;
const DROPPED = /^(?:SELECT|FACET|TIMESERIES|LIMIT|ORDER|COMPARE|SLIDE)/i;

/** Same-length mask: string contents become filler so indices map back to the original text. */
function maskStrings(query: string): string {
  return query.replace(/'(?:[^'\\]|\\.|'')*'/g, (m) => `'${"_".repeat(m.length - 2)}'`);
}

/** Count query for a FACET query: keeps FROM, WHERE, SINCE, UNTIL and WITH TIMEZONE. Null when there is no top-level FACET or no FROM. */
export function facetProbeQuery(query: string): string | null {
  const masked = maskStrings(query);
  const from = masked.search(/\bFROM\b/i);
  if (from < 0) return null;
  const marks = [...masked.matchAll(CLAUSE)].filter((m) => {
    const before = masked.slice(0, m.index);
    return m.index > from && before.split("(").length === before.split(")").length;
  });
  if (!marks.some((m) => /^FACET/i.test(m[0]))) return null;
  const cuts = [from, ...marks.map((m) => m.index), query.length];
  const parts = cuts.slice(0, -1).map((start, i) => ({ start, text: query.slice(start, cuts[i + 1]).trim() }));
  const kept = parts.filter((p) => p.start === from || !DROPPED.test(p.text));
  return `SELECT count(*) ${kept.map((p) => p.text).join(" ")}`;
}

async function emptyFacetNote(provider: NewRelicProvider, sent: string): Promise<string> {
  const probe = facetProbeQuery(sent);
  if (!probe) return "";
  try {
    const { rows } = await provider.executeNrql(probe);
    const n = Object.values(rows[0] ?? {}).find((v) => typeof v === "number") as number | undefined;
    if (n === undefined) return "";
    return n > 0
      ? `No results, but ${n} rows match the FROM and WHERE clauses in this window: none of them has ${parseFacetNames(sent).join(", ")}. FACET on an attribute the rows lack returns nothing; check the names with keyset().`
      : "No row matches the FROM and WHERE clauses in this window.";
  } catch {
    return "";
  }
}

function localTime(ms: number | null | undefined, timeZone: string): string | null {
  return typeof ms === "number" ? new Date(ms).toLocaleString("sv-SE", { timeZone, timeZoneName: "short" }) : null;
}

function buildExecuteNrqlTool(
  provider: NewRelicProvider,
  collectedQueries: SubAgentQuery[],
  db?: Db,
) {
  const ran = new Set<string>();
  return tool({
    description: "Execute a NRQL query against New Relic.",
    inputSchema: z.object({
      query: z.string().describe("The NRQL query to execute. Alias every selected value and facet with AS '<plain name>' (a person reads the column names)."),
      title: z.string().optional().describe("Plain title of what this query measures, read by a person and cited by the answer card."),
    }),
    execute: async ({ query }) => {
      try {
        const timezone = await getTimezone(db);
        const sent = withTimezone(query, timezone);
        const { rows: raw, futureRemoved, window, messages } = await provider.executeNrql(sent);
        const cleaned = sanitizeNrqlRows(raw);
        collectedQueries.push({ query, results: cleaned });
        const key = query.trim().replace(/\s+/g, " ");
        const repeated = ran.has(key);
        ran.add(key);

        const now = Date.now() / 1000;
        const formatted = (formatTimestamps(raw, timezone) as Record<string, unknown>[]).map((r, i) => {
          const end = raw[i].endTimeSeconds;
          return typeof end === "number" && end > now && r.beginTimeSeconds != null ? { ...r, beginTimeSeconds: `${r.beginTimeSeconds} (partial)` } : r;
        });
        const emptyByFuture = cleaned.length === 0 && futureRemoved > 0;
        const csv = emptyByFuture
          ? `No results: all ${futureRemoved} rows start after now and were removed. The window ends in the future.`
          : formatNrqlCsv(formatted, query);
        const notes = [
          window ? `Window: ${localTime(window.begin, timezone)} to ${localTime(window.end, timezone)}` : lacksSince(query) ? "No SINCE: NRQL used the last 60 minutes." : "",
          ...messages.map((m) => `New Relic: ${m}`),
          cleaned.length === 0 && !emptyByFuture ? await emptyFacetNote(provider, sent) : "",
          aliasNote(query),
          repeated ? "You ran this exact query earlier in this reply; the result is above." : "",
        ].filter(Boolean);
        return { parts: [capQuery({ type: "query" as const, query, results: cleaned })], analysis: [csv, ...notes].join("\n") };
      } catch (err) {
        const message = withFixHint(err instanceof Error ? err.message : String(err), query);
        collectedQueries.push({ query, results: { error: message } });
        return { error: message };
      }
    },
    toModelOutput: ({ output }) => toolModelOutput(output),
  });
}

const AGGREGATE = /\b[a-z]+\s*\(/i;

/** A note for a query whose aggregates carry no AS alias, since a person reads the column names. */
export function aliasNote(query: string): string {
  const select = query.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)?.[1] ?? "";
  return AGGREGATE.test(select) && !/\bAS\s+\S/i.test(select) ? "Note: no AS aliases. A person reads these column names; alias every value in the next queries." : "";
}

const ISSUE_LOOKBACK_HOURS = 6;
const ISSUE_ID_LOOKBACK_HOURS = 30 * 24;
const ISSUE_STATES = ["CREATED", "ACTIVATED", "DEACTIVATED", "CLOSED"] as const;

function timeFields(i: AiIssue, timezone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["createdAt", "activatedAt", "closedAt", "acknowledgedAt"] as const) {
    const t = localTime(i[key], timezone);
    if (t) out[key] = t;
  }
  return out;
}

function buildListIssuesTool(provider: NewRelicProvider, db?: Db) {
  return tool({
    description: "List New Relic alert issues with their state, title, condition, priority, entities, times and incident ids. It covers only the last sinceHours hours (default 6, or 30 days when issueIds is given), not all time. Pass a larger sinceHours to look further back. The result has truncated: true when more issues exist than were read.",
    inputSchema: z.object({
      states: z.array(z.enum(ISSUE_STATES)).optional().describe("Keep only these states. Omit for all states."),
      issueIds: z.array(z.string()).optional().describe("Only these issue ids"),
      policyIds: z.array(z.number()).optional().describe("Only issues of these alert policy ids"),
      conditionIds: z.array(z.number()).optional().describe("Only issues of these alert condition ids"),
      sinceHours: z.number().positive().optional().describe(`How far back to look, in hours. Default ${ISSUE_LOOKBACK_HOURS}, or ${ISSUE_ID_LOOKBACK_HOURS} when issueIds is given.`),
    }),
    execute: async ({ states, issueIds, policyIds, conditionIds, sinceHours }) => {
      try {
        const timezone = await getTimezone(db);
        const filter = {
          ...(issueIds?.length ? { ids: issueIds } : {}),
          ...(states?.length ? { states } : {}),
          ...(policyIds?.length ? { policyIds } : {}),
          ...(conditionIds?.length ? { conditionIds } : {}),
        };
        const now = Date.now();
        const hours = sinceHours ?? (issueIds?.length ? ISSUE_ID_LOOKBACK_HOURS : ISSUE_LOOKBACK_HOURS);
        const { issues, truncated } = await provider.aiIssuesPage(filter, now - hours * 3_600_000, now);
        const open = (i: AiIssue) => (i.state === "ACTIVATED" || i.state === "CREATED" ? 0 : 1);
        const sorted = [...issues].sort((a, b) => open(a) - open(b) || (b.activatedAt ?? b.createdAt ?? 0) - (a.activatedAt ?? a.createdAt ?? 0));
        return {
          issues: sorted.map((i) => {
            const titles = [...new Set(i.title ?? [])];
            const conditions = [...new Set(i.conditionName ?? [])];
            return {
              issueId: i.issueId,
              state: i.state,
              title: titles.length > 1 ? titles : titles[0] ?? null,
              conditionName: conditions.length > 1 ? conditions : conditions[0] ?? null,
              incidentIds: i.incidentIds ?? [],
              ...(i.priority ? { priority: i.priority } : {}),
              ...(i.entityNames?.length ? { entityNames: i.entityNames } : {}),
              ...timeFields(i, timezone),
              ...(i.acknowledgedBy ? { acknowledgedBy: i.acknowledgedBy } : {}),
            };
          }),
          sinceHours: hours,
          truncated,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    // The model reads a table under the result cap; the UI keeps the full rows.
    toModelOutput: ({ output }) => {
      if (!output || !("issues" in output) || !output.issues) return toolModelOutput(output);
      const table = output.issues.length ? formatNrqlCsv(output.issues) : "No issues.";
      const notes = [`Covers the last ${output.sinceHours} hours. Open issues first, newest first.`, output.truncated ? "More issues exist than were read: narrow the states, ids or sinceHours." : ""];
      return toolModelOutput({ analysis: [table, ...notes].filter(Boolean).join("\n") });
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

export function buildNewRelicIssueTools(provider: NewRelicProvider, db?: Db): Record<"list_nr_issues" | "ack_nr_issue" | "close_nr_issue", Tool> {
  return {
    list_nr_issues: buildListIssuesTool(provider, db),
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
  db?: unknown,
): { tools: Record<string, unknown>; systemPrompt: string; afterComplete: (params: AfterCompleteParams) => void } {
  const collectedQueries: SubAgentQuery[] = [];

  return {
    tools: {
      execute_nrql: buildExecuteNrqlTool(provider, collectedQueries, db as Db | undefined),
      ...buildNewRelicIssueTools(provider, db as Db | undefined),
      [ANALYSIS_TOOL_NAME]: beginAnalysisTool,
    },
    systemPrompt: injectMemories(directModeSystemPrompt, memoryContext),
    afterComplete: buildAfterComplete({ providerType: "newrelic", db: db as Db | undefined, memoryContext, collectedQueries }),
  };
}


import { z } from "zod";
import { tool } from "ai";
import { eq, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter } from "@tracer-sh/shared";
import { monitors } from "../db/schema.js";
import { collectBaseTools } from "./shared-tool-setup.js";
import { EVIDENCE_GROUNDING, PLAIN_LANGUAGE } from "../lib/shared-prompts.js";
import { MONITOR_PROVIDERS, normalizeDraft, validateMonitor } from "../monitors/validate.js";
import { CONFIG } from "../config.js";

type Monitor = typeof monitors.$inferSelect;

function describeMonitor(m: Monitor): string {
  return `${m.provider} query: ${m.query}${m.chartQuery ? ` | chartQuery: ${m.chartQuery}` : ""} | condition: ${m.condition} | every ${m.frequencySeconds}s`;
}

function getMonitorContext(db: Db): string {
  const rows = db.select().from(monitors).orderBy(desc(monitors.updatedAt)).all();
  if (rows.length === 0) {
    return "## Current Monitors\n(empty) — no monitors created yet.";
  }
  const lines = rows.map(
    (m) => `- "${m.name}" — ${describeMonitor(m)} | ${m.enabled ? "enabled" : "disabled"} | status: ${m.lastStatus}`,
  );
  return `## Current Monitors\n${lines.join("\n")}`;
}

function getEditingContext(db: Db, sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const m = db.select().from(monitors).where(eq(monitors.chatSessionId, sessionId)).get();
  if (!m) return null;
  return `## Editing\nYou are editing monitor "${m.name}" (${describeMonitor(m)}). Propose the full updated monitor with propose_monitor; saving it updates this monitor.`;
}

export function collectMonitorTools(
  registry: ProviderRegistry,
  db: Db,
  writer?: StreamWriter,
) {
  const { tools, promptFragments, connectedProviders } = collectBaseTools(registry, db, writer, "unified");

  tools.propose_monitor = tool({
    description:
      "Validate a New Relic or PostHog count monitor and show it to the user as a draft to review and save. Runs the query over one check window and returns the sample value. Does not save.",
    inputSchema: z.object({
      name: z.string().describe("Short human-readable monitor name"),
      provider: z.enum(MONITOR_PROVIDERS).default("newrelic").describe("Provider that holds the data"),
      query: z.string().describe("Count query: NRQL with SINCE {{SINCE}} UNTIL {{UNTIL}}, or HogQL with timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}})"),
      chartQuery: z.string().optional().describe("PostHog only, required: HogQL timeseries of the same metric with the same placeholders and a time bucket column"),
      condition: z.string().describe('Condition on the summed count, e.g. "> 0"'),
      frequencySeconds: z.number().describe(`Check interval in seconds (default 300, min ${CONFIG.monitorMinFrequencySeconds})`),
    }),
    execute: async ({ name, provider, query, chartQuery, condition, frequencySeconds }) => {
      const draft = normalizeDraft({ name, provider, query, chartQuery, condition, frequencySeconds });
      const result = await validateMonitor(registry, draft, { runQuery: true });
      if ("error" in result) return { error: result.error };
      return {
        draft,
        sampleValue: result.sampleValue,
        groups: result.groups,
        wouldTrigger: result.wouldTrigger,
        chatSessionId: writer?.sessionId,
      };
    },
  });

  const providerNames = connectedProviders.map((p) => p.name).join(", ");
  const providerContext = connectedProviders.length > 0
    ? `## Available Providers\n${providerNames}`
    : "## Available Providers\nNo observability providers are currently connected.";

  const basePrompt = `You are a monitor builder assistant for the Tracer platform. You help the user define one monitor: a count query (New Relic NRQL or PostHog HogQL), a condition on that count, and a check frequency. When the condition is true, Tracer starts a debug session that investigates the cause.

## Workflow
1. Choose the provider that holds the data the user asks about (backend services, APM, infrastructure, alerts: New Relic; product analytics, frontend events, pageviews, feature flags, client exceptions: PostHog). Research with that provider's tools: find the right event type, attributes and filters, and look at recent volumes.
2. Ground the threshold in observed data. Unless the user gave an explicit number, state the baseline you saw (e.g. "usually 0-2 per 5 minutes, triggering above 5").
3. Call propose_monitor with the chosen provider. It validates the query and shows the user a draft card with the sample value.
4. Tell the user to review the draft and click Save. You cannot save monitors yourself.
5. To change the monitor, call propose_monitor again in this same chat with the full updated monitor.

If a tool call fails, retry with a corrected approach. If you fail the same tool call twice, stop and explain the issue to the user.

## Query Rules (New Relic NRQL)
- The query must return a count: use count(*), sum(...) or uniqueCount(...).
- It must end with SINCE {{SINCE}} UNTIL {{UNTIL}}. Tracer replaces them with epoch-millisecond times. Each check covers exactly one window equal to the frequency, and windows never overlap, so each event is counted once.
- Never use literal times (SINCE 5 minutes ago), TIMESERIES or COMPARE WITH.
- Optional: FACET <identity field> LIMIT 100 when the user cares about distinct things (service, entity, alert condition). Facet keys drive repeat detection: a key already investigated in the last 24h is not investigated again. Without FACET, every trigger is investigated.
- Example: SELECT count(*) FROM NrAiIncident WHERE event = 'open' AND policyName LIKE '%foundations%' FACET conditionName LIMIT 100 SINCE {{SINCE}} UNTIL {{UNTIL}}

## Query Rules (PostHog HogQL)
- Use provider "posthog". The query must return a count: count(), sum(...) or count(DISTINCT ...), aliased AS count.
- Filter time with timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}}). Tracer replaces them with epoch-second times; windows never overlap, as above.
- Never use literal times (now() - INTERVAL ...).
- Optional: GROUP BY <identity column> ... LIMIT 100 plays the role of FACET: the non-numeric columns form the group key that drives repeat detection. Put the count as the only numeric column; wrap numeric identity columns in toString(...).
- Example: SELECT properties.$current_url AS url, count() AS count FROM events WHERE event = '$exception' AND timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}}) GROUP BY url ORDER BY count DESC LIMIT 100
- PostHog monitors also require chartQuery: the same metric as a timeseries for the card chart, with the same placeholders, a time bucket column and at most one group column. Example: SELECT toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS bucket, count() AS count FROM events WHERE event = '$exception' AND timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}}) GROUP BY bucket ORDER BY bucket LIMIT 10000
- The chart spans 24 hours to 90 days, so use INTERVAL 1 HOUR buckets and LIMIT 10000 (HogQL returns only 100 rows by default). With a group column: SELECT toStartOfInterval(timestamp, INTERVAL 1 HOUR) AS bucket, properties.$current_url AS url, count() AS count ... GROUP BY bucket, url ORDER BY bucket LIMIT 10000

## Condition
An operator (> >= < <= == !=) and a number, checked against the sum of all counts (all facets or groups added together). Examples: "> 0", ">= 10".

## Frequency
Seconds, at least ${CONFIG.monitorMinFrequencySeconds}. Default to 300 (5 min). Use a shorter interval only if the user explicitly asks for one; use 900+ for slow trends.`;

  const editingContext = getEditingContext(db, writer?.sessionId);
  const systemPrompt = [
    basePrompt,
    EVIDENCE_GROUNDING,
    PLAIN_LANGUAGE,
    providerContext,
    getMonitorContext(db),
    ...(editingContext ? [editingContext] : []),
    ...promptFragments,
  ].join("\n\n");

  return { tools, systemPrompt };
}

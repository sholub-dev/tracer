import { z } from "zod";
import { tool } from "ai";
import { eq, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatToolWriter as StreamWriter } from "@tracer-sh/shared";
import { monitors } from "../db/schema.js";
import { collectBaseTools } from "./shared-tool-setup.js";
import { ANALYSIS_TOOL_NAME } from "./analysis-tool.js";
import { EVIDENCE_GROUNDING, PLAIN_LANGUAGE } from "../lib/shared-prompts.js";
import { MONITOR_PROVIDERS, normalizeDraft, validateMonitor } from "../monitors/validate.js";
import { deleteMonitor, saveMonitor, setMonitorToggles } from "../monitors/store.js";
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
    (m) => `- "${m.name}" (id ${m.id}) — ${describeMonitor(m)} | run ${m.enabled ? "on" : "off"} | alert ${m.alertEnabled ? "on" : "off"} | status: ${m.lastStatus}`,
  );
  return `## Current Monitors\n${lines.join("\n")}`;
}

export function collectMonitorTools(
  registry: ProviderRegistry,
  db: Db,
  activeStreams: ReadonlyMap<string, unknown>,
  writer?: StreamWriter,
) {
  const { tools, promptFragments, connectedProviders } = collectBaseTools(registry, db, writer, "unified");
  // A builder reply is a short confirmation, not an investigation write-up.
  delete tools[ANALYSIS_TOOL_NAME];

  tools.save_monitor = tool({
    description:
      "Create or update a New Relic or PostHog count monitor immediately. Omit monitorId to create (name, query, condition and frequencySeconds required). With monitorId, pass only the fields to change; the rest stay as they are. run/alert set the Run and Alert toggles (use them to disable, pause, mute, enable or resume). Query changes are validated by running the query over one check window.",
    inputSchema: z.object({
      monitorId: z.string().optional().describe("Omit to create a new monitor. Pass the id of an existing monitor (from the monitor list or an earlier save_monitor result) to update it"),
      name: z.string().optional().describe("Short human-readable monitor name"),
      provider: z.enum(MONITOR_PROVIDERS).optional().describe("Provider that holds the data (default newrelic)"),
      query: z.string().optional().describe("Count query: NRQL with SINCE {{SINCE}} UNTIL {{UNTIL}}, or HogQL with timestamp >= toDateTime({{SINCE}}) AND timestamp < toDateTime({{UNTIL}})"),
      chartQuery: z.string().optional().describe("PostHog only, required: HogQL timeseries of the same metric with the same placeholders and a time bucket column"),
      condition: z.string().optional().describe('Condition on the summed count, e.g. "> 0"'),
      frequencySeconds: z.number().optional().describe(`Check interval in seconds (default 300, min ${CONFIG.monitorMinFrequencySeconds})`),
      run: z.boolean().optional().describe("Run toggle: checks run on schedule"),
      alert: z.boolean().optional().describe("Alert toggle: a firing starts a debug session (off still records firings)"),
    }),
    execute: async ({ monitorId, run, alert, ...changes }) => {
      const id = monitorId ?? crypto.randomUUID();
      const existing = monitorId ? db.select().from(monitors).where(eq(monitors.id, monitorId)).get() : undefined;
      if (monitorId && !existing) return { error: `Monitor ${monitorId} not found` };
      const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<typeof changes>;
      let name = existing?.name;
      let sample: { sampleValue?: number; wouldTrigger?: boolean } = {};
      if (!existing || Object.keys(given).length > 0) {
        const merged = { provider: "newrelic" as const, ...existing, ...given };
        if (!merged.name || !merged.query || !merged.condition || !merged.frequencySeconds) {
          return { error: "A new monitor needs name, query, condition and frequencySeconds" };
        }
        const draft = normalizeDraft({ ...merged, name: merged.name, query: merged.query, condition: merged.condition, frequencySeconds: merged.frequencySeconds });
        const result = await validateMonitor(registry, draft, { runQuery: true });
        if ("error" in result) return { error: result.error };
        saveMonitor(db, id, draft);
        name = draft.name;
        sample = { sampleValue: result.sampleValue, wouldTrigger: result.wouldTrigger };
      }
      const toggled = run !== undefined || alert !== undefined ? setMonitorToggles(db, id, { run, alert }) : null;
      if (toggled && "error" in toggled) return { error: toggled.error };
      return { monitorId: id, name, created: !existing, ...sample, ...(toggled ? { run: toggled.run, alert: toggled.alert } : {}) };
    },
  });

  tools.delete_monitor = tool({
    description: "Permanently delete a monitor with its trigger history and debug sessions. Only when the user explicitly asks to delete or remove it; never to disable, pause, mute or change it.",
    inputSchema: z.object({ monitorId: z.string().describe("Id of the monitor to delete") }),
    execute: async ({ monitorId }) => {
      const result = deleteMonitor(db, activeStreams, monitorId);
      return "error" in result ? { error: result.error } : { monitorId, name: result.name, deleted: true };
    },
  });

  const providerNames = connectedProviders.map((p) => p.name).join(", ");
  const providerContext = connectedProviders.length > 0
    ? `## Available Providers\n${providerNames}`
    : "## Available Providers\nNo observability providers are currently connected.";

  const basePrompt = `You are a monitor builder assistant for the Tracer platform. You create, change and delete monitors for the user with your tools, directly: there is no draft or confirmation step. A monitor is a count query (New Relic NRQL or PostHog HogQL), a condition on that count, and a check frequency. When the condition is true, Tracer starts a debug session that investigates the cause.

## Workflow
1. Choose the provider that holds the data the user asks about (backend services, APM, infrastructure, alerts: New Relic; product analytics, frontend events, pageviews, feature flags, client exceptions: PostHog). Research with that provider's tools: find the right event type, attributes and filters, and look at recent volumes.
2. Ground the threshold in observed data. Unless the user gave an explicit number, state the baseline you saw (e.g. "usually 0-2 per 5 minutes, triggering above 5").
3. Call save_monitor with the chosen provider, once per monitor. The user may ask for several monitors in one chat. It validates the query and saves the monitor immediately; the user sees it on the monitors page right away.
4. To change an existing monitor, call save_monitor with its monitorId (from the monitor list or an earlier save_monitor result) and only the fields that change. Without monitorId it creates a new monitor.
5. To turn a monitor's Run or Alert toggle on or off (disable, pause, mute, enable, resume), call save_monitor with its monitorId and run and/or alert. Never delete or re-create a monitor for this.
6. Call delete_monitor only when the user explicitly says delete or remove. Deleting cannot be undone. If the request is unclear, ask first.

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

  const systemPrompt = [
    basePrompt,
    EVIDENCE_GROUNDING,
    PLAIN_LANGUAGE,
    providerContext,
    getMonitorContext(db),
    ...promptFragments,
  ].join("\n\n");

  return { tools, systemPrompt };
}

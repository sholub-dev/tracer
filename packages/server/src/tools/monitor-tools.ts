import { z } from "zod";
import { tool } from "ai";
import { eq, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { unixNow } from "@tracer-sh/shared";
import type { ChatToolWriter as StreamWriter } from "@tracer-sh/shared";
import { monitors } from "../db/schema.js";
import { collectBaseTools } from "./shared-tool-setup.js";
import { validateCondition } from "../monitors/condition.js";
import { requireTimeRangePlaceholders, executeValidationQuery } from "./query-validation.js";
import { CONFIG } from "../config.js";

function getMonitorContext(db: Db): string {
  const rows = db.select().from(monitors).orderBy(desc(monitors.updatedAt)).all();
  if (rows.length === 0) {
    return "## Current Monitors\n(empty) — no monitors created yet.";
  }
  const lines = rows.map(
    (m) =>
      `- [id:${m.id}] "${m.name}" — query: ${m.query} | condition: ${m.condition} | every ${m.frequencySeconds}s | ${m.enabled ? "enabled" : "disabled"} | status: ${m.lastStatus} (provider: ${m.provider})`,
  );
  return `## Current Monitors\n${lines.join("\n")}`;
}

export function collectMonitorTools(
  registry: ProviderRegistry,
  db: Db,
  writer?: StreamWriter,
) {
  const { tools, promptFragments, connectedProviders } = collectBaseTools(registry, db, writer);

  const defaultProvider = connectedProviders[0];

  // ── Monitor CRUD tools ──

  tools.create_monitor = tool({
    description:
      "Create a new monitor that periodically checks a query and alerts when a condition is met.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable monitor name"),
      query: z.string().describe("Query with {{SINCE}} and {{UNTIL}} placeholders"),
      condition: z.string().describe("JS expression evaluated against `result` array, e.g. `result[0].count > 100`"),
      provider: z.string().optional().describe("Provider name (defaults to first connected)"),
      frequencySeconds: z.number().optional().default(60).describe("Check interval in seconds (min 30)"),
    }),
    execute: async ({ name, query, condition, provider: providerName, frequencySeconds }) => {
      const targetProvider = providerName
        ? registry.getProvider(providerName)
        : defaultProvider;

      if (!targetProvider?.connected) {
        return { error: "No connected provider available" };
      }

      const placeholderCheck = requireTimeRangePlaceholders(query);
      if (placeholderCheck) return placeholderCheck;

      const validation = await executeValidationQuery(query, targetProvider, "2 minutes ago");
      if ("error" in validation) return validation;

      // Validate condition expression (syntax + runtime against real data)
      const condCheck = validateCondition(condition, validation.result);
      if ("error" in condCheck) return condCheck;

      const id = crypto.randomUUID();
      const now = unixNow();
      const freq = Math.max(frequencySeconds ?? 60, CONFIG.monitorMinFrequencySeconds);

      db.insert(monitors)
        .values({
          id,
          name,
          provider: targetProvider.name,
          query,
          condition,
          frequencySeconds: freq,
          enabled: 1,
          lastStatus: "ok",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      writer?.write({
        type: "data-monitor-changed",
        data: { action: "created", monitorId: id },
      });

      return { created: true, id, name };
    },
  });

  tools.update_monitor = tool({
    description: "Update an existing monitor by ID.",
    inputSchema: z.object({
      id: z.string().describe("Monitor ID"),
      name: z.string().optional().describe("New name"),
      query: z.string().optional().describe("New query (must have {{SINCE}}/{{UNTIL}})"),
      condition: z.string().optional().describe("New condition expression"),
      frequencySeconds: z.number().optional().describe("New check interval"),
    }),
    execute: async ({ id, name, query, condition, frequencySeconds }) => {
      const existing = db.select().from(monitors).where(eq(monitors.id, id)).get();
      if (!existing) return { error: `Monitor not found: ${id}` };

      if (query && query !== existing.query) {
        const placeholderCheck = requireTimeRangePlaceholders(query);
        if (placeholderCheck) return placeholderCheck;

        const targetProvider = registry.getProvider(existing.provider);
        if (!targetProvider?.connected) {
          return { error: "Provider is not connected" };
        }

        const validation = await executeValidationQuery(query, targetProvider, "2 minutes ago");
        if ("error" in validation) return validation;
      }

      if (condition) {
        // Validate condition syntax first
        const syntaxCheck = validateCondition(condition);
        if ("error" in syntaxCheck) return syntaxCheck;

        // Test condition against real data — catches field name typos
        const targetProvider = registry.getProvider(existing.provider);
        if (targetProvider?.connected) {
          const validation = await executeValidationQuery(query ?? existing.query, targetProvider, "2 minutes ago");
          if ("error" in validation) return validation;
          const runtimeCheck = validateCondition(condition, validation.result);
          if ("error" in runtimeCheck) return runtimeCheck;
        }
      }

      const updates: Record<string, unknown> = {
        updatedAt: unixNow(),
      };
      if (name !== undefined) updates.name = name;
      if (query !== undefined) updates.query = query;
      if (condition !== undefined) updates.condition = condition;
      if (frequencySeconds !== undefined) updates.frequencySeconds = Math.max(frequencySeconds, CONFIG.monitorMinFrequencySeconds);

      db.update(monitors).set(updates).where(eq(monitors.id, id)).run();

      writer?.write({
        type: "data-monitor-changed",
        data: { action: "updated", monitorId: id },
      });

      return { updated: true, id };
    },
  });

  tools.delete_monitor = tool({
    description: "Delete a monitor and all its alerts by ID.",
    inputSchema: z.object({
      id: z.string().describe("Monitor ID to delete"),
    }),
    execute: async ({ id }) => {
      const existing = db.select().from(monitors).where(eq(monitors.id, id)).get();
      if (!existing) return { error: `Monitor not found: ${id}` };

      // CASCADE auto-deletes monitor_alerts
      db.delete(monitors).where(eq(monitors.id, id)).run();

      writer?.write({
        type: "data-monitor-changed",
        data: { action: "deleted", monitorId: id },
      });

      return { deleted: true, id };
    },
  });

  tools.toggle_monitor = tool({
    description: "Enable or disable a monitor.",
    inputSchema: z.object({
      id: z.string().describe("Monitor ID"),
      enabled: z.boolean().describe("true to enable, false to disable"),
    }),
    execute: async ({ id, enabled }) => {
      const existing = db.select().from(monitors).where(eq(monitors.id, id)).get();
      if (!existing) return { error: `Monitor not found: ${id}` };

      db.update(monitors)
        .set({ enabled: enabled ? 1 : 0, updatedAt: unixNow() })
        .where(eq(monitors.id, id))
        .run();

      writer?.write({
        type: "data-monitor-changed",
        data: { action: "updated", monitorId: id },
      });

      return { toggled: true, id, enabled };
    },
  });

  // ── Available providers context ──
  const providerNames = connectedProviders.map((p) => p.name).join(", ");
  const providerContext = connectedProviders.length > 0
    ? `## Available Providers\n${providerNames}`
    : "## Available Providers\nNo observability providers are currently connected.";

  const monitorContext = getMonitorContext(db);

  const basePrompt = `You are a monitor builder assistant for the Tracer platform. You help users create, update, and delete monitors that periodically check observability data and alert when conditions are met.

When a user asks to create a monitor, use the create_monitor tool. When they ask to modify one, use update_monitor. When they ask to remove one, use delete_monitor. Use toggle_monitor to enable/disable.

You can also investigate data using investigation tools to help users understand what queries and conditions would be useful.

If a tool call fails, retry with a corrected approach. If you fail the same tool call twice, DO NOT retry again — stop and explain the issue to the user.

## Query Guidelines
- Every monitor query MUST use {{SINCE}} and {{UNTIL}} placeholders
- Correct:   SELECT count(*) FROM Transaction WHERE error IS true SINCE {{SINCE}} UNTIL {{UNTIL}}
- WRONG:     SELECT count(*) FROM Transaction WHERE error IS true SINCE 5 minutes ago
- The scheduler replaces these with a lookback window based on the monitor's frequency

## Condition Expression
The condition is a JS expression evaluated against the query \`result\` array. Examples:
- \`result[0].count > 100\` — alert when count exceeds 100
- \`result.length === 0\` — alert when no results returned
- \`result[0].average > 2\` — alert when average exceeds 2 seconds
- \`result[0].errorRate > 0.05\` — alert when error rate exceeds 5%

## Frequency Recommendations
- 30s — critical real-time checks
- 60s — standard monitoring (default)
- 300s (5 min) — trend-based checks
- 900s (15 min) — hourly trend summaries

## Scope
You are managing all monitors. The monitor list above shows all existing monitors.`;

  const systemPrompt = [basePrompt, providerContext, monitorContext, ...promptFragments].join("\n\n");

  return { tools, systemPrompt };
}

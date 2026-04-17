import { z } from "zod";
import { tool } from "ai";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { unixNow } from "@tracer-sh/shared";
import type { ChatToolWriter as StreamWriter } from "@tracer-sh/shared";
import { dashboardWidgets, dashboards } from "../db/schema.js";
import { collectBaseTools } from "./shared-tool-setup.js";
import { requireTimeRangePlaceholders, executeValidationQuery } from "./query-validation.js";
import { CONFIG } from "../config.js";

function getWidgetContext(db: Db, dashboardId: string): string {
  const widgets = db.select().from(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, dashboardId)).all();
  if (widgets.length === 0) {
    return "## Current Dashboard Widgets\n(empty) — no widgets on the dashboard yet.";
  }
  const lines = widgets.map(
    (w) =>
      `- [id:${w.id}] "${w.title}" — ${w.query} (${w.posW}×${w.posH}, ${w.chartType}, provider: ${w.provider})`,
  );
  return `## Current Dashboard Widgets\n${lines.join("\n")}`;
}

function nextYPosition(db: Db, dashboardId: string): number {
  const result = db
    .select({ maxY: sql<number>`MAX(pos_y + pos_h)` })
    .from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dashboardId))
    .get();
  return result?.maxY ?? 0;
}

export function collectDashboardTools(
  registry: ProviderRegistry,
  db: Db,
  writer?: StreamWriter,
  dashboardId?: string,
) {
  const dbId = dashboardId ?? "";
  const { tools, promptFragments, connectedProviders } = collectBaseTools(registry, db, writer);

  const defaultProvider = connectedProviders[0];

  // ── Widget CRUD tools ──

  tools.create_widget = tool({
    description:
      "Create a new dashboard widget. The query will be validated by executing it first. The widget auto-positions below existing widgets.",
    inputSchema: z.object({
      title: z.string().describe("Widget title"),
      query: z.string().describe("Query to execute"),
      provider: z.string().optional().describe("Provider name to use (defaults to first connected provider)"),
      chartType: z
        .enum(["auto", "timeseries", "table", "scalar", "histogram"])
        .optional()
        .default("auto")
        .describe("Chart rendering type"),
      width: z.number().optional().default(CONFIG.widgetDefaultWidth).describe(`Grid width (1-${CONFIG.gridColumns} columns). Always use ${CONFIG.widgetDefaultWidth} unless the user explicitly requests a different size.`),
      height: z.number().optional().default(CONFIG.widgetDefaultHeight).describe(`Grid height (1-${CONFIG.gridColumns} rows). Always use ${CONFIG.widgetDefaultHeight} unless the user explicitly requests a different size.`),
    }),
    execute: async ({ title, query, provider: providerName, chartType, width, height }) => {
      const targetProvider = providerName
        ? registry.getProvider(providerName)
        : defaultProvider;

      if (!targetProvider?.connected) {
        return { error: "No connected provider available" };
      }

      const placeholderCheck = requireTimeRangePlaceholders(query);
      if (placeholderCheck) return placeholderCheck;

      const validation = await executeValidationQuery(query, targetProvider, "7 days ago");
      if ("error" in validation) return validation;

      const id = crypto.randomUUID();
      const posY = nextYPosition(db, dbId);
      const now = unixNow();

      // Ensure dashboard row exists (lazy creation — atomic upsert)
      db.insert(dashboards)
        .values({ id: dbId, title: "New Dashboard", createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .run();

      db.insert(dashboardWidgets)
        .values({
          id,
          dashboardId: dbId,
          provider: targetProvider.name,
          title,
          query,
          chartType: chartType ?? "auto",
          posX: 0,
          posY,
          posW: Math.min(Math.max(width ?? CONFIG.widgetDefaultWidth, 1), CONFIG.gridColumns),
          posH: Math.max(height ?? CONFIG.widgetDefaultHeight, 1),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      writer?.write({
        type: "data-widget-changed",
        data: { action: "created", widgetId: id },
      });

      return { created: true, id, title };
    },
  });

  tools.update_widget = tool({
    description:
      "Update an existing dashboard widget by ID. You can change its title, query, chart type, or size. If the query is changed, it will be validated first.",
    inputSchema: z.object({
      id: z.string().describe("Widget ID to update"),
      title: z.string().optional().describe("New title"),
      query: z.string().optional().describe("New query"),
      chartType: z
        .enum(["auto", "timeseries", "table", "scalar", "histogram"])
        .optional()
        .describe("New chart type"),
      width: z.number().optional().describe("New grid width (1-12)"),
      height: z.number().optional().describe("New grid height"),
    }),
    execute: async ({ id, title, query, chartType, width, height }) => {
      const existing = db
        .select()
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.id, id))
        .get();
      if (!existing) return { error: `Widget not found: ${id}` };

      // Validate new query if changed
      if (query && query !== existing.query) {
        const targetProvider = registry.getProvider(existing.provider);
        if (!targetProvider?.connected) {
          return { error: "Provider is not configured or not connected" };
        }

        const placeholderCheck = requireTimeRangePlaceholders(query);
        if (placeholderCheck) return placeholderCheck;

        const validation = await executeValidationQuery(query, targetProvider, "7 days ago");
        if ("error" in validation) return validation;
      }

      const updates: Record<string, unknown> = {
        updatedAt: unixNow(),
      };
      if (title !== undefined) updates.title = title;
      if (query !== undefined) updates.query = query;
      if (chartType !== undefined) updates.chartType = chartType;
      if (width !== undefined) updates.posW = Math.min(Math.max(width, 1), CONFIG.gridColumns);
      if (height !== undefined) updates.posH = Math.max(height, 1);

      db.update(dashboardWidgets)
        .set(updates)
        .where(eq(dashboardWidgets.id, id))
        .run();

      writer?.write({
        type: "data-widget-changed",
        data: { action: "updated", widgetId: id },
      });

      return { updated: true, id };
    },
  });

  tools.delete_widget = tool({
    description: "Delete a dashboard widget by ID.",
    inputSchema: z.object({
      id: z.string().describe("Widget ID to delete"),
    }),
    execute: async ({ id }) => {
      const existing = db
        .select()
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.id, id))
        .get();
      if (!existing) return { error: `Widget not found: ${id}` };

      db.delete(dashboardWidgets)
        .where(eq(dashboardWidgets.id, id))
        .run();

      writer?.write({
        type: "data-widget-changed",
        data: { action: "deleted", widgetId: id },
      });

      return { deleted: true, id };
    },
  });

  // ── Available providers context ──
  const providerNames = connectedProviders.map((p) => p.name).join(", ");
  const providerContext = connectedProviders.length > 0
    ? `## Available Providers\n${providerNames}`
    : "## Available Providers\nNo observability providers are currently connected.";

  // ── Widget context (injected fresh on every request) ──
  const widgetContext = getWidgetContext(db, dbId);

  const basePrompt = `You are a dashboard builder assistant for the Tracer platform. You help users create, update, and delete dashboard widgets that display live observability data.

When a user asks to create a widget, use the create_widget tool with an appropriate query. When they ask to modify one, use update_widget. When they ask to remove one, use delete_widget.

You can also investigate data using investigation tools to help users understand what queries would be useful.

If a tool call fails, retry with a corrected approach. If you fail the same tool call twice, DO NOT retry again — stop and explain the issue to the user.

## Chart Type Selection
- "auto" — let the frontend auto-detect based on query shape
- "timeseries" — for TIMESERIES queries (line charts)
- "table" — for FACET queries without TIMESERIES
- "scalar" — for single-value aggregations
- "histogram" — for histogram() queries

## Widget Sizing
The dashboard uses a ${CONFIG.gridColumns}×${CONFIG.gridColumns} grid (${CONFIG.gridColumns} columns, ${CONFIG.gridColumns} rows fill the viewport). Both axes are responsive to screen size.
IMPORTANT: Always create widgets at the default size of ${CONFIG.widgetDefaultWidth}×${CONFIG.widgetDefaultHeight} (half width, half height) unless the user explicitly requests a specific size. Do NOT choose a different size on your own — only deviate from ${CONFIG.widgetDefaultWidth}×${CONFIG.widgetDefaultHeight} when the user asks for it.

## Time Range Placeholders (MANDATORY)
Every query saved to a widget MUST use {{SINCE}} and {{UNTIL}} placeholders instead of literal time values.
- Correct:   SELECT count(*) FROM Transaction SINCE {{SINCE}} UNTIL {{UNTIL}} TIMESERIES
- WRONG:     SELECT count(*) FROM Transaction SINCE 1 hour ago TIMESERIES
The dashboard has a global date picker that replaces these placeholders at execution time.
Never use literal SINCE/UNTIL values in widget queries. Always use {{SINCE}} and {{UNTIL}}.

## Widget Titles
Never include time ranges in widget titles (e.g. "Errors (last 7 days)", "Throughput - 1 hour").
The global date picker already shows the active time range, so titles should describe WHAT the widget shows, not WHEN.
- Correct:   "Error Rate by App"
- WRONG:     "Error Rate by App (last 7 days)"

## Scope
You are managing widgets for the current dashboard only. The widget list above shows only this dashboard's widgets.`;

  const systemPrompt = [basePrompt, providerContext, widgetContext, ...promptFragments].join("\n\n");

  return { tools, systemPrompt };
}

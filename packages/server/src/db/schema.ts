import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { unixNow } from "@oko/shared";

export const providerConfigs = sqliteTable("provider_configs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull().unique(),
  config: text("config").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
});

export const toolMemories = sqliteTable("tool_memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  toolName: text("tool_name").notNull(),
  note: text("note").notNull(),
  reviewNote: text("review_note"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_memories_tool").on(t.toolName),
]);

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  messages: text("messages").notNull(),
  status: text("status").notNull().default("idle"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_sessions_updated").on(t.updatedAt),
]);

export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_dashboards_updated").on(t.updatedAt),
]);

export const dashboardWidgets = sqliteTable("dashboard_widgets", {
  id: text("id").primaryKey(),
  dashboardId: text("dashboard_id").notNull().default("").references(() => dashboards.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("newrelic"),
  title: text("title").notNull(),
  query: text("query").notNull(),
  chartType: text("chart_type").notNull().default("auto"),
  config: text("config").notNull().default("{}"),
  posX: integer("pos_x").notNull().default(0),
  posY: integer("pos_y").notNull().default(0),
  posW: integer("pos_w").notNull().default(6),
  posH: integer("pos_h").notNull().default(6),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_widgets_dashboard").on(t.dashboardId),
]);

export const monitors = sqliteTable("monitors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull().default("newrelic"),
  query: text("query").notNull(),
  condition: text("condition").notNull(),
  frequencySeconds: integer("frequency_seconds").notNull().default(60),
  enabled: integer("enabled").notNull().default(1),
  lastCheckedAt: integer("last_checked_at"),
  lastStatus: text("last_status").notNull().default("ok"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_monitors_enabled").on(t.enabled),
]);

export const monitorAlerts = sqliteTable("monitor_alerts", {
  id: text("id").primaryKey(),
  monitorId: text("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  triggeredAt: integer("triggered_at").notNull(),
  resolvedAt: integer("resolved_at"),
  resultSnapshot: text("result_snapshot").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_alerts_monitor").on(t.monitorId),
  index("idx_alerts_unresolved").on(t.resolvedAt).where(sql`resolved_at IS NULL`),
]);

export const memoryOperations = sqliteTable("memory_operations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(), // "create" | "update" | "delete"
  memoryId: integer("memory_id"),
  note: text("note"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_memops_session").on(t.sessionId),
]);

export const subAgentRuns = sqliteTable("sub_agent_runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id"),
  provider: text("provider").notNull(),
  task: text("task").notNull(),
  queryCount: integer("query_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  stepCount: integer("step_count").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  finishReason: text("finish_reason"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_sub_agent_runs_provider").on(t.provider),
  index("idx_sub_agent_runs_created").on(t.createdAt),
  index("idx_sub_agent_runs_session").on(t.sessionId),
]);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  agentType: text("agent_type").notNull(),
  model: text("model"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  reasoningTokens: integer("reasoning_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_agent_runs_session").on(t.sessionId),
  index("idx_agent_runs_type").on(t.agentType),
]);

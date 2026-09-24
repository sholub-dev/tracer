import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";

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
  /** Null for normal sessions. "imported" for sessions re-hydrated from a dropped analysis PNG. */
  kind: text("kind"),
  /** Compaction: LLM-generated (possibly user-edited) summary of the first summaryUpTo messages. */
  summary: text("summary"),
  /** Count of leading messages covered by the summary. Index-based because
   *  assistant messages can carry empty ids; prefixes are stable here (messages
   *  are only appended or suffix-truncated, never reordered). */
  summaryUpTo: integer("summary_up_to"),
  summaryCreatedAt: integer("summary_created_at"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_sessions_updated").on(t.updatedAt),
  index("idx_sessions_status_kind").on(t.status, t.kind, t.id),
  index("idx_sessions_list").on(t.updatedAt, t.kind, t.status, t.id, t.title),
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
  chartQuery: text("chart_query"),
  condition: text("condition").notNull(),
  frequencySeconds: integer("frequency_seconds").notNull().default(60),
  enabled: integer("enabled").notNull().default(1),
  lastCheckedAt: integer("last_checked_at"),
  lastStatus: text("last_status").notNull().default("ok"),
  lastError: text("last_error"),
  chatSessionId: text("chat_session_id"),
  sortOrder: integer("sort_order"),
  cardWidth: integer("card_width"),
  alertEnabled: integer("alert_enabled").notNull().default(1),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => unixNow()),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => unixNow()),
}, (t) => [
  index("idx_monitors_enabled").on(t.enabled),
]);

export const monitorTriggers = sqliteTable("monitor_triggers", {
  id: text("id").primaryKey(),
  monitorId: text("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  triggeredAt: integer("triggered_at").notNull(),
  value: real("value").notNull(),
  windowStart: integer("window_start").notNull(),
  windowEnd: integer("window_end").notNull(),
  status: text("status").notNull(), // "investigating" | "repeat" | "muted"
  groups: text("groups").notNull(),
  sessionId: text("session_id"),
}, (t) => [
  index("idx_triggers_monitor").on(t.monitorId, t.triggeredAt),
  index("idx_triggers_session").on(t.sessionId),
  index("idx_triggers_recent_session").on(t.triggeredAt).where(sql`session_id IS NOT NULL`),
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

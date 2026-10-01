import { sqlite } from "./client.js";

export function runSetup(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS provider_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL UNIQUE,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tool_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      kind TEXT,
      summary TEXT,
      summary_up_to INTEGER,
      summary_created_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL DEFAULT '' REFERENCES dashboards(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'newrelic',
      title TEXT NOT NULL,
      query TEXT NOT NULL,
      chart_type TEXT NOT NULL DEFAULT 'auto',
      config TEXT NOT NULL DEFAULT '{}',
      pos_x INTEGER NOT NULL DEFAULT 0,
      pos_y INTEGER NOT NULL DEFAULT 0,
      pos_w INTEGER NOT NULL DEFAULT 6,
      pos_h INTEGER NOT NULL DEFAULT 6,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'newrelic',
      query TEXT NOT NULL,
      chart_query TEXT,
      condition TEXT NOT NULL,
      frequency_seconds INTEGER NOT NULL DEFAULT 60,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      last_status TEXT NOT NULL DEFAULT 'ok',
      last_error TEXT,
      sort_order INTEGER,
      card_width INTEGER,
      alert_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS monitor_triggers (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      triggered_at INTEGER NOT NULL,
      value REAL NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      status TEXT NOT NULL,
      groups TEXT NOT NULL,
      session_id TEXT,
      reported TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_issues (
      issue_id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      trigger_id TEXT NOT NULL REFERENCES monitor_triggers(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      condition_name TEXT NOT NULL,
      title TEXT NOT NULL,
      severity TEXT,
      verdict TEXT,
      state TEXT NOT NULL,
      last_error TEXT,
      watch_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_timers (
      session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
      fire_at INTEGER,
      note TEXT NOT NULL,
      set_at INTEGER NOT NULL
    );

    DROP INDEX IF EXISTS idx_alert_issues_due;
    CREATE INDEX IF NOT EXISTS idx_alert_issues_state ON alert_issues(state);
    CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON dashboard_widgets(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_memories_tool ON tool_memories(tool_name);
    CREATE INDEX IF NOT EXISTS idx_dashboards_updated ON dashboards(updated_at);
    CREATE INDEX IF NOT EXISTS idx_monitors_enabled ON monitors(enabled);
    CREATE INDEX IF NOT EXISTS idx_triggers_monitor ON monitor_triggers(monitor_id, triggered_at);
    CREATE INDEX IF NOT EXISTS idx_triggers_session ON monitor_triggers(session_id);
    CREATE INDEX IF NOT EXISTS idx_triggers_recent_session ON monitor_triggers(triggered_at) WHERE session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS memory_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      memory_id INTEGER,
      note TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      agent_type TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_memops_session ON memory_operations(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
  `);

  // Back-compat: columns added after initial release.
  for (const ddl of [
    `ALTER TABLE tool_memories ADD COLUMN review_note TEXT`,
    `ALTER TABLE chat_sessions ADD COLUMN kind TEXT`,
    `ALTER TABLE chat_sessions ADD COLUMN summary TEXT`,
    `ALTER TABLE chat_sessions ADD COLUMN summary_up_to INTEGER`,
    `ALTER TABLE chat_sessions ADD COLUMN summary_created_at INTEGER`,
    `ALTER TABLE monitors ADD COLUMN last_error TEXT`,
    `ALTER TABLE monitors ADD COLUMN sort_order INTEGER`,
    `ALTER TABLE monitors ADD COLUMN card_width INTEGER`,
    `ALTER TABLE monitors ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE monitors ADD COLUMN chart_query TEXT`,
    // Drops the short-lived id-based boundary column (never shipped in a release).
    `ALTER TABLE chat_sessions DROP COLUMN summary_up_to_id`,
  ]) {
    try { sqlite.exec(ddl); } catch { /* column already exists */ }
  }
  // Firings from before this column were all reported already.
  try {
    sqlite.exec(`ALTER TABLE monitor_triggers ADD COLUMN reported TEXT`);
    sqlite.exec(`UPDATE monitor_triggers SET reported = 'done'`);
  } catch { /* column already exists */ }

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_status_kind ON chat_sessions(status, kind, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_list ON chat_sessions(updated_at, kind, status, id, title);
    DROP INDEX IF EXISTS idx_sessions_updated;
    DROP INDEX IF EXISTS idx_agent_runs_type;
  `);

  // 0.3.7: one model setting for everything — clear old per-provider overrides and
  // reset any saved chat model once, so every install starts on the new default.
  const marked = sqlite.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('model_reset_0_3_7', 'true')`).run();
  if (marked.changes) {
    sqlite.exec(`DELETE FROM app_settings WHERE key = 'chat_model' OR key LIKE 'sub_agent_model:%'`);
  }

  // Migration: add FK constraints to existing tables that lack them.
  // SQLite doesn't support ALTER TABLE ADD FOREIGN KEY, so we recreate tables.
  migrateForeignKeys();
}

function migrateForeignKeys(): void {
  const fks = sqlite.pragma("foreign_key_list(dashboard_widgets)") as unknown[];
  if (fks.length > 0) return; // Already migrated

  // Check if the table even exists (fresh install already has FKs from CREATE TABLE above)
  const tableInfo = sqlite.pragma("table_info(dashboard_widgets)") as unknown[];
  if (tableInfo.length === 0) return; // Table doesn't exist yet

  console.log("[db] Migrating tables to add foreign key constraints...");

  // Must disable FKs for the migration (can't alter schema with FKs active)
  sqlite.pragma("foreign_keys = OFF");

  sqlite.exec("BEGIN TRANSACTION");
  try {
    // Clean orphaned rows before migration
    sqlite.exec(`
      DELETE FROM dashboard_widgets
        WHERE dashboard_id != '' AND dashboard_id NOT IN (SELECT id FROM dashboards);
      DELETE FROM memory_operations
        WHERE session_id NOT IN (SELECT id FROM chat_sessions);
    `);

    // Recreate dashboard_widgets with FK
    sqlite.exec(`
      ALTER TABLE dashboard_widgets RENAME TO _dashboard_widgets_old;
      CREATE TABLE dashboard_widgets (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL DEFAULT '' REFERENCES dashboards(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'newrelic',
        title TEXT NOT NULL,
        query TEXT NOT NULL,
        chart_type TEXT NOT NULL DEFAULT 'auto',
        config TEXT NOT NULL DEFAULT '{}',
        pos_x INTEGER NOT NULL DEFAULT 0,
        pos_y INTEGER NOT NULL DEFAULT 0,
        pos_w INTEGER NOT NULL DEFAULT 6,
        pos_h INTEGER NOT NULL DEFAULT 6,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO dashboard_widgets SELECT * FROM _dashboard_widgets_old;
      DROP TABLE _dashboard_widgets_old;
    `);

    // Recreate memory_operations with FK
    sqlite.exec(`
      ALTER TABLE memory_operations RENAME TO _memory_operations_old;
      CREATE TABLE memory_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        memory_id INTEGER,
        note TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO memory_operations SELECT * FROM _memory_operations_old;
      DROP TABLE _memory_operations_old;
    `);

    // Recreate indexes on the new tables
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON dashboard_widgets(dashboard_id);
      CREATE INDEX IF NOT EXISTS idx_memops_session ON memory_operations(session_id);
    `);

    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }

  // Re-enable FKs after migration
  sqlite.pragma("foreign_keys = ON");

  // Verify migration
  const check = sqlite.pragma("foreign_key_check") as unknown[];
  if (check.length > 0) {
    console.warn("[db] Foreign key check found violations after migration:", check);
  } else {
    console.log("[db] Foreign key migration completed successfully.");
  }
}

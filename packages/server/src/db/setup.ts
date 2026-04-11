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
      condition TEXT NOT NULL,
      frequency_seconds INTEGER NOT NULL DEFAULT 60,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at INTEGER,
      last_status TEXT NOT NULL DEFAULT 'ok',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS monitor_alerts (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      triggered_at INTEGER NOT NULL,
      resolved_at INTEGER,
      result_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sub_agent_runs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      task TEXT NOT NULL,
      query_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      finish_reason TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON dashboard_widgets(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_memories_tool ON tool_memories(tool_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON chat_sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_dashboards_updated ON dashboards(updated_at);
    CREATE INDEX IF NOT EXISTS idx_monitors_enabled ON monitors(enabled);
    CREATE INDEX IF NOT EXISTS idx_alerts_monitor ON monitor_alerts(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON monitor_alerts(resolved_at) WHERE resolved_at IS NULL;
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

    CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_provider ON sub_agent_runs(provider);
    CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_created ON sub_agent_runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_memops_session ON memory_operations(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_type ON agent_runs(agent_type);
  `);

  // Back-compat: columns added after initial release.
  for (const ddl of [
    `ALTER TABLE sub_agent_runs ADD COLUMN session_id TEXT`,
    `ALTER TABLE tool_memories ADD COLUMN review_note TEXT`,
  ]) {
    try { sqlite.exec(ddl); } catch { /* column already exists */ }
  }

  // Index on session_id must be created after the ALTER TABLE migration above
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_session ON sub_agent_runs(session_id)`);

  // Migration: add FK constraints to existing tables that lack them.
  // SQLite doesn't support ALTER TABLE ADD FOREIGN KEY, so we recreate tables.
  migrateForeignKeys();

  // Force direct mode for all users until orchestrator mode is re-introduced.
  // Users who previously toggled to orchestrator have stale DB values with no UI to change back.
  sqlite.exec(`DELETE FROM app_settings WHERE key = 'chat_mode'`);
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
      DELETE FROM monitor_alerts
        WHERE monitor_id NOT IN (SELECT id FROM monitors);
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

    // Recreate monitor_alerts with FK
    sqlite.exec(`
      ALTER TABLE monitor_alerts RENAME TO _monitor_alerts_old;
      CREATE TABLE monitor_alerts (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        triggered_at INTEGER NOT NULL,
        resolved_at INTEGER,
        result_snapshot TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO monitor_alerts SELECT * FROM _monitor_alerts_old;
      DROP TABLE _monitor_alerts_old;
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
      CREATE INDEX IF NOT EXISTS idx_alerts_monitor ON monitor_alerts(monitor_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON monitor_alerts(resolved_at) WHERE resolved_at IS NULL;
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

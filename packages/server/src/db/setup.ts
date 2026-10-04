import type { SetupDriver } from "./driver.js";

/** Settings that belong to one device: they never leave it and a copy or merge never touches them. */
export const LOCAL_SETTING_KEYS = ["device_id", "sync_peer_id", "sync_peer_name", "sync_last_at", "sync_marks"];

// Synced table -> key column that identifies a row on every device, and the column that dates existing rows.
export const SYNC_KEYS: Record<string, { key: string; time?: string }> = {
  provider_configs: { key: "type", time: "created_at" },
  app_settings: { key: "key", time: "updated_at" },
  tool_memories: { key: "uid", time: "created_at" },
  chat_sessions: { key: "id", time: "updated_at" },
  dashboards: { key: "id", time: "updated_at" },
  dashboard_widgets: { key: "id", time: "updated_at" },
  monitors: { key: "id", time: "updated_at" },
  monitor_triggers: { key: "id" },
  alert_issues: { key: "issue_id", time: "updated_at" },
  memory_operations: { key: "uid", time: "created_at" },
  agent_runs: { key: "id", time: "created_at" },
};

// Device state, not content: scheduler ticks and pausing write the monitor columns, and opening an
// unread session writes its status. A write to only these must not count as a change to sync.
const UNSYNCED_COLUMNS: Record<string, string[]> = {
  monitors: ["enabled", "last_checked_at", "last_status", "last_error", "updated_at"],
  chat_sessions: ["status"],
};

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export async function runSetup(sqlite: SetupDriver): Promise<void> {
  await sqlite.exec(`
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
      reason TEXT,
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

  // Back-compat: columns added after initial release. Checked first, because the iOS
  // SQLite plugin logs every failed statement as an error.
  const known = new Map<string, Set<string>>();
  const columns = async (table: string) => {
    let names = known.get(table);
    if (!names) {
      names = new Set((await sqlite.all(`PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name));
      known.set(table, names);
    }
    return names;
  };
  for (const [table, column, type] of [
    ["tool_memories", "review_note", "TEXT"],
    ["chat_sessions", "kind", "TEXT"],
    ["chat_sessions", "summary", "TEXT"],
    ["chat_sessions", "summary_up_to", "INTEGER"],
    ["chat_sessions", "summary_created_at", "INTEGER"],
    ["monitors", "last_error", "TEXT"],
    ["monitors", "sort_order", "INTEGER"],
    ["monitors", "card_width", "INTEGER"],
    ["monitors", "alert_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["monitors", "chart_query", "TEXT"],
    ["alert_issues", "reason", "TEXT"],
  ]) {
    const names = await columns(table);
    if (names.has(column)) continue;
    await sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    names.add(column);
  }
  // Drops the short-lived id-based boundary column (never shipped in a release).
  if ((await columns("chat_sessions")).has("summary_up_to_id")) {
    await sqlite.exec(`ALTER TABLE chat_sessions DROP COLUMN summary_up_to_id`);
  }
  // Firings from before this column were all reported already.
  if (!(await columns("monitor_triggers")).has("reported")) {
    await sqlite.exec(`ALTER TABLE monitor_triggers ADD COLUMN reported TEXT`);
    await sqlite.exec(`UPDATE monitor_triggers SET reported = 'done'`);
  }

  await sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_status_kind ON chat_sessions(status, kind, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_list ON chat_sessions(updated_at, kind, status, id, title);
    DROP INDEX IF EXISTS idx_sessions_updated;
    DROP INDEX IF EXISTS idx_agent_runs_type;
  `);

  // 0.3.7: one model setting for everything — clear old per-provider overrides and
  // reset any saved chat model once, so every install starts on the new default.
  const marked = await sqlite.all(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('model_reset_0_3_7', 'true') RETURNING key`);
  if (marked.length > 0) {
    await sqlite.exec(`DELETE FROM app_settings WHERE key = 'chat_model' OR key LIKE 'sub_agent_model:%'`);
  }

  // Migration: add FK constraints to existing tables that lack them.
  // SQLite doesn't support ALTER TABLE ADD FOREIGN KEY, so we recreate tables.
  await migrateForeignKeys(sqlite);

  await setupSync(sqlite);
}

async function setupSync(sqlite: SetupDriver): Promise<void> {
  // Uids come after the foreign-key migration, which copies memory_operations column by column.
  for (const table of ["tool_memories", "memory_operations"]) {
    const names = (await sqlite.all(`PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name);
    if (!names.includes("uid")) await sqlite.exec(`ALTER TABLE ${table} ADD COLUMN uid TEXT`);
  }
  await sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_rows (
      tbl TEXT NOT NULL,
      row_key TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      local_at INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tbl, row_key)
    );
    UPDATE tool_memories SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    UPDATE memory_operations SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON tool_memories(uid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memops_uid ON memory_operations(uid);
    CREATE TRIGGER IF NOT EXISTS tool_memories_uid AFTER INSERT ON tool_memories WHEN NEW.uid IS NULL
      BEGIN UPDATE tool_memories SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS memory_operations_uid AFTER INSERT ON memory_operations WHEN NEW.uid IS NULL
      BEGIN UPDATE memory_operations SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('device_id', '${crypto.randomUUID()}');
  `);

  // local_at is this device's own clock for the change; changed_at can carry another device's time after a merge.
  const logColumns = (await sqlite.all(`PRAGMA table_info(sync_rows)`) as { name: string }[]).map((c) => c.name);
  if (!logColumns.includes("local_at")) {
    await sqlite.exec(`ALTER TABLE sync_rows ADD COLUMN local_at INTEGER NOT NULL DEFAULT 0`);
    await sqlite.exec(`UPDATE sync_rows SET local_at = changed_at`);
  }

  const local = LOCAL_SETTING_KEYS.map((k) => `'${k}'`).join(", ");
  const columns = new Map<string, string[]>();
  for (const table of Object.keys(SYNC_KEYS)) {
    columns.set(table, (await sqlite.all(`PRAGMA table_info(${table})`) as { name: string }[]).map((c) => c.name));
  }
  // Dropped and rebuilt each start, so a changed definition replaces the old one.
  const statements: string[] = [];
  for (const [table, { key, time }] of Object.entries(SYNC_KEYS)) {
    const isSettings = table === "app_settings";
    const upsert = (row: "NEW" | "OLD", deleted: 0 | 1) =>
      `INSERT INTO sync_rows (tbl, row_key, changed_at, local_at, deleted) VALUES ('${table}', ${row}.${key}, ${NOW_MS}, ${NOW_MS}, ${deleted})
        ON CONFLICT (tbl, row_key) DO UPDATE SET changed_at = excluded.changed_at, local_at = excluded.local_at, deleted = excluded.deleted;`;
    const when = (row: "NEW" | "OLD") => {
      const conditions = [`${row}.${key} IS NOT NULL`];
      if (isSettings) conditions.push(`${row}.key NOT IN (${local})`);
      return `WHEN ${conditions.join(" AND ")}`;
    };
    const unsynced = UNSYNCED_COLUMNS[table];
    const updateOf = unsynced
      ? ` OF ${columns.get(table)!.filter((c) => !unsynced.includes(c)).join(", ")}`
      : "";
    statements.push(
      `DROP TRIGGER IF EXISTS sync_${table}_ins;`,
      `DROP TRIGGER IF EXISTS sync_${table}_upd;`,
      `DROP TRIGGER IF EXISTS sync_${table}_del;`,
      `CREATE TRIGGER sync_${table}_ins AFTER INSERT ON ${table} ${when("NEW")} BEGIN ${upsert("NEW", 0)} END;`,
      `CREATE TRIGGER sync_${table}_upd AFTER UPDATE${updateOf} ON ${table} ${when("NEW")} BEGIN ${upsert("NEW", 0)} END;`,
      `CREATE TRIGGER sync_${table}_del AFTER DELETE ON ${table} ${when("OLD")} BEGIN ${upsert("OLD", 1)} END;`,
      `INSERT OR IGNORE INTO sync_rows (tbl, row_key, changed_at, local_at, deleted)
        SELECT '${table}', ${key}, ${time ? `${time} * 1000` : "0"}, ${time ? `${time} * 1000` : "0"}, 0 FROM ${table}${isSettings ? ` WHERE key NOT IN (${local})` : ""};`,
    );
  }
  await sqlite.exec(statements.join("\n"));
}

async function migrateForeignKeys(sqlite: SetupDriver): Promise<void> {
  const fks = await sqlite.all("PRAGMA foreign_key_list(dashboard_widgets)");
  if (fks.length > 0) return; // Already migrated

  // Check if the table even exists (fresh install already has FKs from CREATE TABLE above)
  const tableInfo = await sqlite.all("PRAGMA table_info(dashboard_widgets)");
  if (tableInfo.length === 0) return; // Table doesn't exist yet

  console.log("[db] Migrating tables to add foreign key constraints...");

  // Must disable FKs for the migration (can't alter schema with FKs active)
  await sqlite.exec("PRAGMA foreign_keys = OFF");

  await sqlite.exec("BEGIN TRANSACTION");
  try {
    // Clean orphaned rows before migration
    await sqlite.exec(`
      DELETE FROM dashboard_widgets
        WHERE dashboard_id != '' AND dashboard_id NOT IN (SELECT id FROM dashboards);
      DELETE FROM memory_operations
        WHERE session_id NOT IN (SELECT id FROM chat_sessions);
    `);

    // Recreate dashboard_widgets with FK
    await sqlite.exec(`
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
    await sqlite.exec(`
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
    await sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_widgets_dashboard ON dashboard_widgets(dashboard_id);
      CREATE INDEX IF NOT EXISTS idx_memops_session ON memory_operations(session_id);
    `);

    await sqlite.exec("COMMIT");
  } catch (err) {
    await sqlite.exec("ROLLBACK");
    throw err;
  }

  // Re-enable FKs after migration
  await sqlite.exec("PRAGMA foreign_keys = ON");

  // Verify migration
  const check = await sqlite.all("PRAGMA foreign_key_check");
  if (check.length > 0) {
    console.warn("[db] Foreign key check found violations after migration:", check);
  } else {
    console.log("[db] Foreign key migration completed successfully.");
  }
}

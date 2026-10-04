import { gte, notInArray } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { runInTransaction, type Db } from "../db/driver.js";
import * as schema from "../db/schema.js";
import { LOCAL_SETTING_KEYS } from "../db/setup.js";

// Parents before children, so inserts satisfy the foreign keys and deletes run in reverse.
export const TABLES: [string, SQLiteTable][] = [
  ["provider_configs", schema.providerConfigs],
  ["app_settings", schema.appSettings],
  ["tool_memories", schema.toolMemories],
  ["chat_sessions", schema.chatSessions],
  ["dashboards", schema.dashboards],
  ["dashboard_widgets", schema.dashboardWidgets],
  ["monitors", schema.monitors],
  ["monitor_triggers", schema.monitorTriggers],
  ["alert_issues", schema.alertIssues],
  ["session_timers", schema.sessionTimers],
  ["memory_operations", schema.memoryOperations],
  ["agent_runs", schema.agentRuns],
];

export const FORMAT = 3;

export interface Snapshot {
  format: number;
  tables: Record<string, Record<string, unknown>[]>;
  rows: SyncRow[];
}

export interface SyncRow {
  tbl: string;
  row_key: string;
  changed_at: number;
  deleted: number;
}

/** Reads one table. Device-local settings are left out. */
export function readTable(tx: Db, name: string, table: SQLiteTable): Promise<Record<string, unknown>[]> {
  const query = tx.select().from(table);
  return (name === "app_settings" ? query.where(notInArray(schema.appSettings.key, LOCAL_SETTING_KEYS)) : query).all() as Promise<Record<string, unknown>[]>;
}

/** With `since`, only the entries this device changed at or after that local time. */
export async function readSyncRows(tx: Db, since?: number): Promise<SyncRow[]> {
  const query = tx.select().from(schema.syncRows);
  const rows = await (since === undefined ? query : query.where(gte(schema.syncRows.localAt, since))).all();
  return rows.map((r) => ({ tbl: r.tbl, row_key: r.rowKey, changed_at: r.changedAt, deleted: r.deleted }));
}

export async function exportSnapshot(db: Db): Promise<Snapshot> {
  const tables: Snapshot["tables"] = {};
  // One transaction: a session written between two table reads would leave child rows without their parent.
  let rows: SyncRow[] = [];
  await runInTransaction(db, async (tx) => {
    for (const [name, table] of TABLES) tables[name] = await readTable(tx, name, table);
    rows = await readSyncRows(tx);
  });
  return { format: FORMAT, tables, rows };
}

// Keeps each insert small: one statement crosses the iOS native bridge as a single message.
export function* batches<T>(rows: T[]) {
  let batch: T[] = [];
  let size = 0;
  for (const row of rows) {
    const rowSize = JSON.stringify(row).length;
    if (batch.length > 0 && (batch.length >= 100 || size + rowSize > 1_000_000)) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(row);
    size += rowSize;
  }
  if (batch.length > 0) yield batch;
}

/**
 * Replaces every row in this database with the rows in the snapshot, except this device's own settings. Returns the row count per table.
 * With `pauseMonitors`, the copied monitors arrive paused and the copied follow-up timers are dropped.
 */
export async function importSnapshot(db: Db, snapshot: Snapshot, options: { pauseMonitors?: boolean } = {}): Promise<Record<string, number>> {
  if (snapshot.format !== FORMAT) throw new Error("The copy comes from a different Tracer version. Update both apps to the same version.");
  const counts: Record<string, number> = {};
  const localAt = Date.now();
  await runInTransaction(db, async (tx) => {
    for (const [name, table] of [...TABLES].reverse()) {
      await (name === "app_settings" ? tx.delete(table).where(notInArray(schema.appSettings.key, LOCAL_SETTING_KEYS)) : tx.delete(table)).run();
    }
    for (const [name, table] of TABLES) {
      const rows = snapshot.tables[name] ?? [];
      for (const batch of batches(rows)) await tx.insert(table).values(batch as never).run();
      counts[name] = rows.length;
    }
    // The triggers logged the import itself; the receiver takes the sender's log, so the next merge finds no difference.
    await tx.delete(schema.syncRows).run();
    for (const batch of batches(snapshot.rows ?? [])) {
      await tx.insert(schema.syncRows).values(batch.map((r) => ({ tbl: r.tbl, rowKey: r.row_key, changedAt: r.changed_at, localAt, deleted: r.deleted }))).run();
    }
    if (options.pauseMonitors) {
      await tx.update(schema.monitors).set({ enabled: 0 }).run();
      await tx.delete(schema.sessionTimers).run();
    }
  });
  return counts;
}

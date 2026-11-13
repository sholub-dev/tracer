import { and, asc, getTableColumns, gt, gte, ne, notInArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { runInTransaction, type Db } from "../db/driver.js";
import * as schema from "../db/schema.js";
import { LOCAL_SETTING_KEYS } from "../db/setup.js";
import { isSlackWebhook } from "../integrations/slack.js";
import { isPosthogHost, isPosthogProjectId } from "../providers/posthog/posthog.client.js";
import { isJiraDomain } from "../integrations/jira/jira.client.js";

// Parents before children, so inserts satisfy the foreign keys and deletes run in reverse.
export const TABLES: [string, SQLiteTable][] = [
  ["provider_configs", schema.providerConfigs],
  ["app_settings", schema.appSettings],
  ["tool_memories", schema.toolMemories],
  ["chat_sessions", schema.chatSessions],
  ["monitors", schema.monitors],
  ["monitor_triggers", schema.monitorTriggers],
  ["alert_issues", schema.alertIssues],
  ["session_timers", schema.sessionTimers],
  ["memory_operations", schema.memoryOperations],
  ["agent_runs", schema.agentRuns],
];

export const FORMAT = 5;

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

/** Vertex AI authenticates through gcloud on the desktop, so a phone cannot use it. */
const DESKTOP_ONLY_PROVIDER = "google-vertex";
const CHAT_MODEL_KEY = "chat_model";

/** True for a row the phone cannot use: a desktop-only provider config, or the chat model that selects such a provider. */
export function isDesktopOnly(table: string, row: Record<string, unknown>): boolean {
  if (table === "provider_configs") return row.type === DESKTOP_ONLY_PROVIDER;
  if (table !== "app_settings" || row.key !== CHAT_MODEL_KEY) return false;
  try {
    return JSON.parse(String(row.value))?.provider === DESKTOP_ONLY_PROVIDER;
  } catch {
    return false;
  }
}

/** Run state belongs to the device that ran it: another device must never resume or show a live run. */
export const SESSION_RUN_STATE = { status: "done", runScope: null, resumed: 0 };

/** Rows per read; a session row carries its whole message list, so one read of all rows would hold every transcript at once. */
const READ_PAGE_ROWS = 200;

/** Reads one table. Device-local settings and desktop-only provider configs are left out, and sessions export no run state. */
export async function readTable(tx: Db, name: string, table: SQLiteTable, match?: SQL): Promise<Record<string, unknown>[]> {
  const where = name === "app_settings"
    ? and(match, notInArray(schema.appSettings.key, LOCAL_SETTING_KEYS))
    : name === "provider_configs" ? and(match, ne(schema.providerConfigs.type, DESKTOP_ONLY_PROVIDER)) : match;
  const rowid = sql<number>`rowid`;
  const rows: Record<string, unknown>[] = [];
  for (let cursor = -1; ;) {
    const page = await tx.select({ ...getTableColumns(table), __rowid: rowid }).from(table)
      .where(and(where, gt(rowid, cursor))).orderBy(asc(rowid)).limit(READ_PAGE_ROWS).all() as Record<string, unknown>[];
    for (const { __rowid, ...row } of page) {
      rows.push(name === "chat_sessions" ? { ...row, ...SESSION_RUN_STATE } : row);
      cursor = __rowid as number;
    }
    if (page.length < READ_PAGE_ROWS) return rows;
  }
}

/** Throws when a row has a column the table does not have, or an integration setting that points anywhere unexpected. */
export function checkRows(name: string, table: SQLiteTable, rows: Record<string, unknown>[]): void {
  const columns = new Set(Object.keys(getTableColumns(table)));
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error(`The data has an invalid row in ${name}.`);
    for (const key of Object.keys(row)) {
      if (!columns.has(key)) throw new Error(`The data has an unknown column "${key}" in ${name}.`);
    }
    if (name === "app_settings") checkSetting(row.key, row.value);
    if (name === "provider_configs") checkProviderConfig(row.type, row.config);
  }
}

function checkSetting(key: unknown, value: unknown): void {
  if (typeof key !== "string" || !key.startsWith("integration:")) return;
  let config: { webhookUrl?: unknown; domain?: unknown } | null = null;
  try { config = JSON.parse(String(value)); } catch { /* rejected below */ }
  const valid = key === "integration:slack" ? typeof config?.webhookUrl === "string" && isSlackWebhook(config.webhookUrl)
    : key === "integration:jira" ? typeof config?.domain === "string" && isJiraDomain(config.domain)
      : false;
  if (!valid) throw new Error(`The data has an invalid setting "${key}".`);
}

function checkProviderConfig(type: unknown, value: unknown): void {
  if (type !== "posthog") return;
  let config: { host?: unknown; projectId?: unknown } | null = null;
  try { config = JSON.parse(String(value)); } catch { /* rejected below */ }
  const host = config?.host;
  const valid = (host === undefined || host === "" || (typeof host === "string" && isPosthogHost(host.trim().replace(/\/+$/, ""))))
    && (config?.projectId === undefined || (typeof config.projectId === "string" && isPosthogProjectId(config.projectId)));
  if (!valid) throw new Error(`The data has an invalid provider config "${type}".`);
}

/** With `since`, only the entries this device changed at or after that local time. */
export async function readSyncRows(tx: Db, since?: number): Promise<SyncRow[]> {
  const query = tx.select().from(schema.syncRows);
  // A fixed order: the local_at index otherwise changes the order between a full and an incremental read.
  const rows = await (since === undefined ? query : query.where(gte(schema.syncRows.localAt, since))).orderBy(schema.syncRows.tbl, schema.syncRows.rowKey).all();
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
 * Follow-up timers belong to the source device, so none are copied: the same re-check must not run on both devices.
 */
export async function importSnapshot(db: Db, snapshot: Snapshot): Promise<Record<string, number>> {
  if (snapshot.format !== FORMAT) throw new Error("The copy comes from a different Tracer version. Update both apps to the same version.");
  const counts: Record<string, number> = {};
  const localAt = Date.now();
  for (const [name, table] of TABLES) checkRows(name, table, snapshot.tables[name] ?? []);
  await runInTransaction(db, async (tx) => {
    // A chat model this phone cannot run leaves the phone's own choice in place.
    const keepLocalModel = (snapshot.tables.app_settings ?? []).some((r) => isDesktopOnly("app_settings", r));
    const keep = keepLocalModel ? [...LOCAL_SETTING_KEYS, CHAT_MODEL_KEY] : LOCAL_SETTING_KEYS;
    for (const [name, table] of [...TABLES].reverse()) {
      await (name === "app_settings" ? tx.delete(table).where(notInArray(schema.appSettings.key, keep)) : tx.delete(table)).run();
    }
    for (const [name, table] of TABLES) {
      const rows = name === "session_timers" ? [] : (snapshot.tables[name] ?? []).filter((r) => !isDesktopOnly(name, r));
      for (const batch of batches(rows)) await tx.insert(table).values(batch as never).run();
      counts[name] = rows.length;
    }
    // The triggers logged the import itself; the receiver takes the sender's log, so the next merge finds no difference.
    await tx.delete(schema.syncRows).run();
    for (const batch of batches(snapshot.rows ?? [])) {
      await tx.insert(schema.syncRows).values(batch.map((r) => ({ tbl: r.tbl, rowKey: r.row_key, changedAt: r.changed_at, localAt, deleted: r.deleted }))).run();
    }
  });
  return counts;
}

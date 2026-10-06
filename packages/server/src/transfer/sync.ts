import { eq, getTableColumns, inArray } from "drizzle-orm";
import { runInTransaction, type Db } from "../db/driver.js";
import * as schema from "../db/schema.js";
import { LOCAL_SETTING_KEYS, SYNC_KEYS } from "../db/setup.js";
import { FORMAT, readSyncRows, readTable, TABLES, type SyncRow } from "./snapshot.js";

export { LOCAL_SETTING_KEYS, SYNC_KEYS };

type Row = Record<string, any>;

export interface SyncPayload {
  format: number;
  tables: Record<string, Row[]>;
  rows: SyncRow[];
}

// Parents before children. Follow-up timers stay on their device.
const SYNCED = TABLES.filter(([name]) => name in SYNC_KEYS);
const tableOf = new Map(SYNCED);

// Child table -> [foreign key property, parent table]: a child without its parent is skipped.
const PARENTS: Record<string, [string, string][]> = {
  dashboard_widgets: [["dashboardId", "dashboards"]],
  monitor_triggers: [["monitorId", "monitors"]],
  alert_issues: [["monitorId", "monitors"], ["triggerId", "monitor_triggers"]],
  memory_operations: [["sessionId", "chat_sessions"]],
  agent_runs: [["sessionId", "chat_sessions"]],
};

// Each device numbers these itself, so the remote id is never copied.
const LOCAL_IDS = new Set(["provider_configs", "tool_memories", "memory_operations"]);
const MONITOR_RUNTIME = ["enabled", "lastCheckedAt", "lastStatus", "lastError"];

/** The property name and column of a table's sync key. */
function keyOf(name: string): { prop: string; column: any } {
  const [prop, column] = Object.entries(getTableColumns(tableOf.get(name)!) as Record<string, any>).find(([, c]) => c.name === SYNC_KEYS[name].key)!;
  return { prop, column };
}

const CHUNK = 500;

/** The rows of one table whose column value is in `values`, read in chunks that stay under the SQL variable limit. */
async function readWhere(tx: Db, name: string, column: any, values: unknown[]): Promise<Row[]> {
  const found: Row[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    found.push(...(await readTable(tx, name, tableOf.get(name)!, inArray(column, values.slice(i, i + CHUNK) as never[]))));
  }
  return found;
}

/** With `since`, only the rows this device changed at or after that local time, deletes included. */
export async function exportSyncPayload(db: Db, since?: number): Promise<SyncPayload> {
  const tables: SyncPayload["tables"] = {};
  let rows: SyncRow[] = [];
  await runInTransaction(db, async (tx) => {
    rows = await readSyncRows(tx, since);
    if (since === undefined) {
      for (const [name, table] of SYNCED) tables[name] = await readTable(tx, name, table);
      return;
    }
    const changed = new Map<string, string[]>();
    for (const r of rows) {
      const keys = changed.get(r.tbl);
      if (keys) keys.push(r.row_key);
      else changed.set(r.tbl, [r.row_key]);
    }
    for (const [name] of SYNCED) tables[name] = await readWhere(tx, name, keyOf(name).column, changed.get(name) ?? []);
    // The receiver maps a memory operation to its memory through the memory's uid, even when the memory did not change.
    const have = new Set(tables.tool_memories.map((m) => m.id));
    const wanted = [...new Set(tables.memory_operations.map((o) => o.memoryId as number | null))].filter((id): id is number => id != null && !have.has(id));
    tables.tool_memories.push(...(await readWhere(tx, "tool_memories", schema.toolMemories.id, wanted)));
  });
  return { format: FORMAT, tables, rows };
}

function omit(row: Row, keys: string[]): Row {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Applies the remote rows that changed after the local ones. The newest change wins and ties keep the local row.
 * Returns how many rows were written and deleted per table.
 */
export async function mergeSyncPayload(db: Db, remote: SyncPayload): Promise<{ applied: Record<string, number>; deleted: Record<string, number> }> {
  if (remote.format !== FORMAT) throw new Error("The data comes from a different Tracer version. Update both apps to the same version.");
  const applied: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  for (const [name] of SYNCED) applied[name] = deleted[name] = 0;

  return runInTransaction(db, async (tx) => {
    const logged = new Map((await readSyncRows(tx)).map((r) => [`${r.tbl}\0${r.row_key}`, r.changed_at]));
    const newer = new Map<string, SyncRow[]>();
    for (const entry of remote.rows) {
      if (!(entry.tbl in SYNC_KEYS)) continue;
      if (entry.tbl === "app_settings" && LOCAL_SETTING_KEYS.includes(entry.row_key)) continue;
      if (entry.changed_at > (logged.get(`${entry.tbl}\0${entry.row_key}`) ?? -1)) {
        const list = newer.get(entry.tbl);
        if (list) list.push(entry);
        else newer.set(entry.tbl, [entry]);
      }
    }
    // Overrides the time the triggers just wrote, so both devices end with the same log.
    const log = (entry: SyncRow) => tx.insert(schema.syncRows)
      .values({ tbl: entry.tbl, rowKey: entry.row_key, changedAt: entry.changed_at, localAt: Date.now(), deleted: entry.deleted })
      .onConflictDoUpdate({ target: [schema.syncRows.tbl, schema.syncRows.rowKey], set: { changedAt: entry.changed_at, localAt: Date.now(), deleted: entry.deleted } }).run();

    for (const [name, table] of [...SYNCED].reverse()) {
      for (const entry of (newer.get(name) ?? []).filter((e) => e.deleted)) {
        await tx.delete(table).where(eq(keyOf(name).column, entry.row_key)).run();
        await log(entry);
        deleted[name]++;
      }
    }

    // Many children share a parent: each parent is looked up once. Deletes ran above, so a found parent stays.
    const foundParents = new Map<string, Set<unknown>>();
    const hasParent = async (parent: string, key: unknown) => {
      let found = foundParents.get(parent);
      if (!found) foundParents.set(parent, (found = new Set()));
      if (found.has(key)) return true;
      const { column } = keyOf(parent);
      if (!(await tx.select({ key: column }).from(tableOf.get(parent)!).where(eq(column, key)).get())) return false;
      found.add(key);
      return true;
    };

    const memoryUid = new Map<unknown, unknown>((remote.tables.tool_memories ?? []).map((m) => [m.id, m.uid]));
    for (const [name, table] of SYNCED) {
      const { prop, column } = keyOf(name);
      const incoming = new Map((remote.tables[name] ?? []).map((r) => [String(r[prop]), r]));
      for (const entry of (newer.get(name) ?? []).filter((e) => !e.deleted)) {
        const row = incoming.get(entry.row_key);
        if (!row) continue;
        let orphan = false;
        for (const [fk, parent] of PARENTS[name] ?? []) {
          if (!(await hasParent(parent, row[fk]))) orphan = true;
        }
        if (orphan) continue;

        let values = LOCAL_IDS.has(name) ? omit(row, ["id"]) : row;
        if (name === "memory_operations") {
          const uid = memoryUid.get(row.memoryId);
          const local = uid == null ? undefined : await tx.select({ id: schema.toolMemories.id }).from(schema.toolMemories).where(eq(schema.toolMemories.uid, String(uid))).get();
          values = { ...values, memoryId: local?.id ?? null };
        }
        let insert = values;
        if (name === "monitors") {
          // A monitor new to this device starts paused; an existing one keeps its own run state.
          values = omit(values, MONITOR_RUNTIME);
          insert = { ...values, enabled: 0 };
        }
        await tx.insert(table).values(insert as never).onConflictDoUpdate({ target: column, set: omit(values, [prop]) as never }).run();
        await log(entry);
        applied[name]++;
      }
    }
    return { applied, deleted };
  });
}

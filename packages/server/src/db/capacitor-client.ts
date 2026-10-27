import { createSerializedDb, type Db, type SetupDriver } from "./driver.js";

/** The part of a `@capacitor-community/sqlite` connection this driver uses. */
export interface CapacitorConnection {
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<{ changes?: { changes?: number; lastId?: number } }>;
  query(statement: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
  execute(statements: string, transaction?: boolean): Promise<unknown>;
}

export function createCapacitorDb(conn: CapacitorConnection): { db: Db; setupDriver: SetupDriver } {
  // transaction=false: the plugin otherwise wraps each call in its own BEGIN/COMMIT.
  const { db, exclusive } = createSerializedDb(async (statement, params, method) => {
    if (method === "run") {
      const r = await conn.run(statement, params, false);
      return { rows: [], changes: r.changes?.changes, lastId: r.changes?.lastId };
    }
    const r = await conn.query(statement, params);
    // Rows arrive as objects in column order; drizzle maps columns by position.
    const rows = (r.values ?? []).map((row) => Object.values(row).map((v) => (v === undefined ? null : v)));
    return { rows: method === "get" ? rows[0] : rows };
  });

  const setupDriver: SetupDriver = {
    exec: (statements) => exclusive(async () => { await conn.execute(statements, false); }),
    all: (statement) => exclusive(async () => (await conn.query(statement, [])).values ?? []),
  };

  return { db, setupDriver };
}

import type { Database } from "better-sqlite3-multiple-ciphers";
import { createSerializedDb, type Db, type SetupDriver } from "./driver.js";

export function createNodeDb(sqlite: Database): { db: Db; setupDriver: SetupDriver } {
  const { db, exclusive } = createSerializedDb(async (statement, params, method) => {
    const stmt = sqlite.prepare(statement);
    if (method === "run") {
      const r = stmt.run(...params);
      return { rows: [], changes: r.changes, lastId: Number(r.lastInsertRowid) };
    }
    // drizzle maps columns by position.
    stmt.raw(true);
    return { rows: (method === "get" ? stmt.get(...params) : stmt.all(...params)) as unknown[] };
  });

  const setupDriver: SetupDriver = {
    exec: (sql) => exclusive(async () => { sqlite.exec(sql); }),
    all: (sql) => exclusive(async () => sqlite.prepare(sql).all()),
  };

  return { db, setupDriver };
}

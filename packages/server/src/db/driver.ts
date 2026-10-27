import { sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { drizzle, type AsyncRemoteCallback } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.js";

export type Db = BaseSQLiteDatabase<"sync" | "async", any, typeof schema>;

/** Raw SQL access for schema setup, so each driver can supply its own. */
export interface SetupDriver {
  exec(sql: string): Promise<void> | void;
  all(sql: string): Promise<unknown[]> | unknown[];
}

export type TransactionRunner = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;

const transactionRunners = new WeakMap<Db, TransactionRunner>();

/** Lets a driver whose connection is shared across async flows supply its own transaction handling. */
export function setTransactionRunner(db: Db, runner: TransactionRunner): void {
  transactionRunners.set(db, runner);
}

/**
 * Builds a Db on one connection that every async flow shares. Statements take turns, so a
 * statement from one flow never runs inside another flow's open transaction.
 */
export function createSerializedDb(execute: AsyncRemoteCallback): {
  db: Db;
  exclusive: <T>(task: () => Promise<T>) => Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
  const db: Db = drizzle((statement, params, method) => exclusive(() => execute(statement, params, method)), { schema });
  // A transaction holds the turn from BEGIN to COMMIT, so its own statements skip the wait.
  const txDb: Db = drizzle(execute, { schema });
  setTransactionRunner(db, (fn) => exclusive(() => runInTransaction(txDb, fn)));
  return { db, exclusive };
}

// Transactions on one connection take turns: a second BEGIN while one is open fails.
let transactionTail: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` between BEGIN IMMEDIATE and COMMIT, or ROLLBACK if it throws.
 * `fn` must do only DB work and keep it short: statements that other async flows run
 * while `fn` awaits land inside the transaction.
 */
export async function runInTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const runner = transactionRunners.get(db);
  if (runner) return runner(fn);
  const result = transactionTail.then(async () => {
    await db.run(sql`BEGIN IMMEDIATE`);
    try {
      const value = await fn(db);
      await db.run(sql`COMMIT`);
      return value;
    } catch (err) {
      // SQLite already rolled back after some errors; the original error is the one to report.
      await Promise.resolve(db.run(sql`ROLLBACK`)).catch(() => {});
      throw err;
    }
  });
  transactionTail = result.catch(() => {});
  return result;
}

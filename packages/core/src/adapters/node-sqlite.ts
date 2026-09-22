/**
 * SqlDriver backed by Node's built-in `node:sqlite`.
 *
 * This is the development and test adapter. The device uses a JSI binding
 * instead; both satisfy the same port, so core does not know the difference.
 *
 * `node:sqlite` is marked experimental in Node 22. That is acceptable here
 * precisely because it sits behind the port — replacing it is a file, not a
 * refactor.
 */

import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '../ports/sql.js';

export interface NodeSqliteOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  location?: string;
}

export class NodeSqliteDriver implements SqlDriver {
  #db: DatabaseSync;
  #txDepth = 0;

  constructor(opts: NodeSqliteOptions = {}) {
    this.#db = new DatabaseSync(opts.location ?? ':memory:');
    // Foreign keys are off by default in SQLite and the schema leans on
    // ON DELETE CASCADE for correct deletion, so this is load-bearing.
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec('PRAGMA journal_mode = WAL;');
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    this.#db.prepare(sql).run(...(params as SqlValue[]));
  }

  async all<T = Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    return this.#db.prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  async get<T = Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    const row = this.#db.prepare(sql).get(...(params as SqlValue[]));
    return (row as T | undefined) ?? null;
  }

  async exec(sql: string): Promise<void> {
    this.#db.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction via savepoints, so a helper that
    // opens its own transaction stays composable.
    const isOuter = this.#txDepth === 0;
    const name = `sp_${this.#txDepth}`;
    this.#db.exec(isOuter ? 'BEGIN' : `SAVEPOINT ${name}`);
    this.#txDepth++;
    try {
      const result = await fn();
      this.#txDepth--;
      this.#db.exec(isOuter ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.#txDepth--;
      try {
        this.#db.exec(isOuter ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
        if (!isOuter) this.#db.exec(`RELEASE ${name}`);
      } catch (rollbackErr) {
        // Surface both: a failed rollback means the DB is in an unknown state
        // and hiding it behind the original error makes that undebuggable.
        throw new AggregateError(
          [err, rollbackErr],
          'transaction failed and rollback also failed',
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

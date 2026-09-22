/**
 * Storage port.
 *
 * Core depends on this interface, never on a concrete SQLite binding, so the
 * same domain logic runs against the device's JSI binding, the Node adapter
 * used in tests, and anything else later. See docs/01-architecture.md § Ports.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface SqlDriver {
  /** Run a statement that returns no rows. */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;

  /** Run a query and return all rows. */
  all<T = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;

  /** Run a query and return the first row, or null. */
  get<T = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T | null>;

  /** Execute a multi-statement script (migrations). */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a transaction, committing on success and rolling back on
   * any throw. Implementations must not silently swallow the rollback error.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

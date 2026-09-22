/**
 * Migration runner.
 *
 * Deliberately minimal: forward-only, recorded in a table, wrapped in a
 * transaction. Devices skip versions (a user who opens the app after six
 * months jumps several releases), so migrations must be safe to apply in a
 * batch and must never assume the previous version ran recently.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import * as m001 from './migrations/001_initial.js';
import * as m002 from './migrations/002_chunks_embeddings.js';
import * as m003 from './migrations/003_concepts.js';
import * as m004 from './migrations/004_retention.js';
import * as m005 from './migrations/005_suggestions.js';
import * as m006 from './migrations/006_telemetry.js';

export interface Migration {
  id: string;
  up: string;
}

/** Ordered. Never reorder or edit an applied migration; append a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { id: m001.id, up: m001.up },
  { id: m002.id, up: m002.up },
  { id: m003.id, up: m003.up },
  { id: m004.id, up: m004.up },
  { id: m005.id, up: m005.up },
  { id: m006.id, up: m006.up },
];

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migration (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(
  db: SqlDriver,
  clock: Clock,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrateResult> {
  await db.exec(MIGRATION_TABLE);

  const rows = await db.all<{ id: string }>('SELECT id FROM schema_migration');
  const done = new Set(rows.map((r) => r.id));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of migrations) {
    if (done.has(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }
    await db.transaction(async () => {
      await db.exec(migration.up);
      await db.run('INSERT INTO schema_migration (id, applied_at) VALUES (?, ?)', [
        migration.id,
        clock.now(),
      ]);
    });
    applied.push(migration.id);
  }

  return { applied, alreadyApplied };
}

/** Migration ids applied to this database, in order. */
export async function appliedMigrations(db: SqlDriver): Promise<string[]> {
  await db.exec(MIGRATION_TABLE);
  const rows = await db.all<{ id: string }>(
    'SELECT id FROM schema_migration ORDER BY id',
  );
  return rows.map((r) => r.id);
}

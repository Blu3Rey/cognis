/**
 * Deletion.
 *
 * Deletion is real deletion, not a flag (docs/09-privacy-and-security.md). The
 * count of removed rows is returned because deletion the user cannot verify is
 * deletion they have to take on faith.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Ulid } from '../types.js';

export interface DeleteReport {
  deletedRows: Record<string, number>;
}

/** Tables cascaded from `source`, in the order a reader would expect them. */
const CASCADE_TABLES = [
  'annotation',
  'reading_session',
  'document_version',
  'ingestion_event',
  'source',
] as const;

async function countForSource(db: SqlDriver, sourceId: Ulid): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const q = async (table: string, sql: string) => {
    const row = await db.get<{ n: number }>(sql, [sourceId]);
    counts[table] = row?.n ?? 0;
  };
  await q('source', 'SELECT COUNT(*) AS n FROM source WHERE id = ?');
  await q('ingestion_event', 'SELECT COUNT(*) AS n FROM ingestion_event WHERE source_id = ?');
  await q('document_version', 'SELECT COUNT(*) AS n FROM document_version WHERE source_id = ?');
  await q(
    'reading_session',
    `SELECT COUNT(*) AS n FROM reading_session
      WHERE ingestion_event_id IN (SELECT id FROM ingestion_event WHERE source_id = ?)`,
  );
  await q(
    'annotation',
    `SELECT COUNT(*) AS n FROM annotation
      WHERE document_version_id IN (SELECT id FROM document_version WHERE source_id = ?)`,
  );
  return counts;
}

/**
 * Delete a source and everything derived from it.
 *
 * Relies on ON DELETE CASCADE, which means `PRAGMA foreign_keys = ON` is
 * load-bearing — an adapter that forgets it leaves orphans behind silently.
 * The post-delete assertion below is what catches that.
 */
export async function deleteSource(
  db: SqlDriver,
  sourceId: Ulid,
): Promise<DeleteReport> {
  return db.transaction(async () => {
    const deletedRows = await countForSource(db, sourceId);
    await db.run('DELETE FROM source WHERE id = ?', [sourceId]);

    const remaining = await countForSource(db, sourceId);
    const orphans = Object.entries(remaining).filter(([, n]) => n > 0);
    if (orphans.length > 0) {
      throw new Error(
        `deletion left orphaned rows (foreign keys off?): ${orphans
          .map(([t, n]) => `${t}=${n}`)
          .join(', ')}`,
      );
    }

    // User assertions about the source are attested judgments about a thing
    // that no longer exists; remove them too so deletion is complete.
    const assertions = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM user_assertion
        WHERE subject_type = 'source' AND subject_id = ?`,
      [sourceId],
    );
    if ((assertions?.n ?? 0) > 0) {
      await db.run(
        `DELETE FROM user_assertion WHERE subject_type = 'source' AND subject_id = ?`,
        [sourceId],
      );
    }
    deletedRows['user_assertion'] = assertions?.n ?? 0;

    return { deletedRows };
  });
}

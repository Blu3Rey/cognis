/**
 * Delete a concept's history.
 *
 * A data right from docs/09: removes mentions, memory state and reviews for a
 * concept, leaving the SOURCES intact. The user is saying "stop tracking this
 * idea", not "I never read those articles" — conflating the two would delete
 * material they still want.
 *
 * Reviews are attested, so deleting them is a deliberate, user-initiated act
 * rather than something the system does on its own. The count is returned
 * because deletion the user cannot verify is deletion they take on faith.
 */

import type { SqlDriver } from '../ports/sql.js';

export interface ConceptDeleteReport {
  deletedRows: Record<string, number>;
  /** True when the concept itself was removed for having no evidence left. */
  conceptRemoved: boolean;
}

export async function deleteConceptHistory(
  db: SqlDriver,
  conceptId: string,
): Promise<ConceptDeleteReport> {
  return db.transaction(async () => {
    const count = async (sql: string, params: string[] = [conceptId]): Promise<number> =>
      (await db.get<{ n: number }>(sql, params))?.n ?? 0;

    const deletedRows: Record<string, number> = {
      mention: await count('SELECT COUNT(*) AS n FROM mention WHERE concept_id = ?'),
      review: await count('SELECT COUNT(*) AS n FROM review WHERE concept_id = ?'),
      quiz_item: await count('SELECT COUNT(*) AS n FROM quiz_item WHERE concept_id = ?'),
      coverage: await count('SELECT COUNT(*) AS n FROM coverage WHERE concept_id = ?'),
      edge: await count(
        'SELECT COUNT(*) AS n FROM edge WHERE from_concept = ? OR to_concept = ?',
        [conceptId, conceptId],
      ),
      suggestion: await count('SELECT COUNT(*) AS n FROM suggestion WHERE concept_id = ?'),
      memory_state: 0,
      user_assertion: await count(
        `SELECT COUNT(*) AS n FROM user_assertion
          WHERE subject_type = 'concept' AND subject_id = ?`,
      ),
    };

    // Memory state is keyed by item, so it is counted through the items.
    const memory = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memory_state
        WHERE scope = 'item' AND scope_id IN (SELECT id FROM quiz_item WHERE concept_id = ?)`,
      [conceptId],
    );
    deletedRows['memory_state'] = memory?.n ?? 0;

    await db.run(
      `DELETE FROM memory_state WHERE scope = 'item'
        AND scope_id IN (SELECT id FROM quiz_item WHERE concept_id = ?)`,
      [conceptId],
    );
    await db.run('DELETE FROM review WHERE concept_id = ?', [conceptId]);
    await db.run('DELETE FROM quiz_item WHERE concept_id = ?', [conceptId]);
    await db.run('DELETE FROM mention WHERE concept_id = ?', [conceptId]);
    await db.run('DELETE FROM coverage WHERE concept_id = ?', [conceptId]);
    await db.run('DELETE FROM suggestion WHERE concept_id = ?', [conceptId]);
    await db.run(
      'DELETE FROM edge WHERE from_concept = ? OR to_concept = ?',
      [conceptId, conceptId],
    );
    await db.run(
      `DELETE FROM user_assertion WHERE subject_type = 'concept' AND subject_id = ?`,
      [conceptId],
    );

    // The concept node itself goes only if nothing references it any more.
    const remaining = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mention WHERE concept_id = ?', [conceptId],
    );
    let conceptRemoved = false;
    if ((remaining?.n ?? 0) === 0) {
      await db.run('DELETE FROM concept WHERE id = ?', [conceptId]);
      conceptRemoved = true;
    }

    return { deletedRows, conceptRemoved };
  });
}

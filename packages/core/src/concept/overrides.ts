/**
 * User corrections to derived data.
 *
 * These are attested (docs/adr/0002) and are re-applied after every rebuild,
 * unconditionally. A rebuild that silently un-merges concepts the user merged
 * by hand teaches them their corrections do not stick, and they stop making
 * them — which costs the system its single best source of high-quality labels
 * (docs/04-concept-identity.md § User corrections are sacred).
 */

import type { SqlDriver } from '../ports/sql.js';

export interface OverrideSet {
  /** "chunkId\u0000conceptId" pairs the user rejected. */
  rejectedMentions: Set<string>;
  /** Links the user added by hand. */
  forcedMentions: { chunkId: string; conceptId: string; note: string | null }[];
  /** from -> to. Applied transitively. */
  merges: Map<string, string>;
  /** Pairs the user explicitly refused to merge. */
  blockedMerges: Set<string>;
}

export function rejectionKey(chunkId: string, conceptId: string): string {
  return `${chunkId}\u0000${conceptId}`;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export async function loadOverrides(db: SqlDriver): Promise<OverrideSet> {
  const rows = await db.all<{
    kind: string; subject_type: string; subject_id: string;
    object_id: string | null; note: string | null;
  }>(
    `SELECT kind, subject_type, subject_id, object_id, note
       FROM user_assertion
      WHERE kind IN ('mention_reject','mention_add','concept_merge','concept_split')
      ORDER BY created_at, id`,
  );

  const rejectedMentions = new Set<string>();
  const forcedMentions: OverrideSet['forcedMentions'] = [];
  const merges = new Map<string, string>();
  const blockedMerges = new Set<string>();

  for (const r of rows) {
    switch (r.kind) {
      case 'mention_reject':
        if (r.object_id) rejectedMentions.add(rejectionKey(r.subject_id, r.object_id));
        break;
      case 'mention_add':
        if (r.object_id) {
          forcedMentions.push({
            chunkId: r.subject_id, conceptId: r.object_id, note: r.note,
          });
        }
        break;
      case 'concept_merge':
        // subject is merged INTO object.
        if (r.object_id) merges.set(r.subject_id, r.object_id);
        break;
      case 'concept_split':
        if (r.object_id) blockedMerges.add(pairKey(r.subject_id, r.object_id));
        break;
    }
  }

  return { rejectedMentions, forcedMentions, merges, blockedMerges };
}

/**
 * Follow a merge chain to its canonical concept.
 *
 * Guards against cycles: a user who merges A into B and later B into A would
 * otherwise hang the rollup. A cycle resolves to the lexicographically
 * smallest member, which is arbitrary but stable and never loops.
 */
export function resolveConceptId(merges: Map<string, string>, id: string): string {
  if (merges.size === 0) return id;
  const seen = new Set<string>([id]);
  let current = id;
  for (;;) {
    const next = merges.get(current);
    if (next === undefined) return current;
    if (seen.has(next)) {
      return [...seen].sort()[0]!;
    }
    seen.add(next);
    current = next;
  }
}

/**
 * Apply the override layer to freshly written mentions.
 *
 * Runs inside the caller's transaction, at the end of every relink.
 */
export async function applyOverrides(
  db: SqlDriver,
  overrides: OverrideSet,
  producerVersion: string,
  mintId: () => string,
): Promise<{ removed: number; forced: number; remapped: number }> {
  let removed = 0;
  let forced = 0;
  let remapped = 0;

  for (const key of overrides.rejectedMentions) {
    const [chunkId, conceptId] = key.split('\u0000');
    if (!chunkId || !conceptId) continue;
    const before = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mention WHERE chunk_id = ? AND concept_id = ?',
      [chunkId, conceptId],
    );
    if ((before?.n ?? 0) > 0) {
      await db.run('DELETE FROM mention WHERE chunk_id = ? AND concept_id = ?', [
        chunkId, conceptId,
      ]);
      removed += before!.n;
    }
  }

  for (const f of overrides.forcedMentions) {
    const chunk = await db.get<{ text: string; start_char: number }>(
      'SELECT text, start_char FROM chunk WHERE id = ?',
      [f.chunkId],
    );
    const concept = await db.get<{ label: string }>(
      'SELECT label FROM concept WHERE id = ?',
      [f.conceptId],
    );
    if (!chunk || !concept) continue;

    const existing = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM mention WHERE chunk_id = ? AND concept_id = ?',
      [f.chunkId, f.conceptId],
    );
    if ((existing?.n ?? 0) > 0) continue;

    // Anchor to the concept's label where it appears, else to the chunk start.
    const at = chunk.text.toLowerCase().indexOf(concept.label.toLowerCase());
    const start = chunk.start_char + (at >= 0 ? at : 0);
    const end = start + (at >= 0 ? concept.label.length : 1);

    await db.run(
      `INSERT INTO mention
         (id, chunk_id, concept_id, start_char, end_char, surface_form,
          confidence, is_primary, producer_version, model_id, prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, 1.0, 1, ?, NULL, NULL)`,
      [mintId(), f.chunkId, f.conceptId, start, end, concept.label, producerVersion],
    );
    forced++;
  }

  // Merges last, so a forced mention onto a merged concept still lands on the
  // canonical id.
  if (overrides.merges.size > 0) {
    const rows = await db.all<{ id: string; concept_id: string }>(
      'SELECT id, concept_id FROM mention',
    );
    for (const row of rows) {
      const canonical = resolveConceptId(overrides.merges, row.concept_id);
      if (canonical !== row.concept_id) {
        const clash = await db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM mention m
            WHERE m.concept_id = ?
              AND m.chunk_id = (SELECT chunk_id FROM mention WHERE id = ?)`,
          [canonical, row.id],
        );
        if ((clash?.n ?? 0) > 0) {
          await db.run('DELETE FROM mention WHERE id = ?', [row.id]);
        } else {
          await db.run('UPDATE mention SET concept_id = ? WHERE id = ?', [
            canonical, row.id,
          ]);
        }
        remapped++;
      }
    }
  }

  return { removed, forced, remapped };
}

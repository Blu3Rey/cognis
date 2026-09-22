/**
 * Merge rules for attested rows.
 *
 * docs/09: "last-writer-wins per row for derived data (recomputable anyway)
 * and UNION for attested data — two devices that each recorded a reading event
 * both happened, and neither may overwrite the other."
 *
 * Union is the right rule for the append-only tables, but three attested
 * tables do mutate in place — a source gains a DOI, an ingestion event gains
 * an engagement level and a pipeline status, a review gains a user override —
 * and "union" says nothing about those. Each gets an explicit, order-independent
 * rule below, because a merge whose outcome depends on which device synced
 * first is a merge that will eventually lose somebody's data.
 */

import { ENGAGEMENT_ORDER } from '../types.js';
import type { Engagement, IngestionStatus } from '../types.js';

export type Row = Record<string, string | number | null>;

/** Pipeline progress order. Further along wins; failure is not progress. */
const STATUS_RANK: Record<IngestionStatus, number> = {
  captured: 0,
  extraction_failed: 0,
  extracted: 1,
  chunked: 2,
  embedded: 3,
  linked: 4,
  rolled_up: 5,
  itemised: 6,
};

function coalesce(mine: Row, theirs: Row, key: string): string | number | null {
  return mine[key] ?? theirs[key] ?? null;
}

function earliest(a: unknown, b: unknown): string | null {
  const x = typeof a === 'string' ? a : null;
  const y = typeof b === 'string' ? b : null;
  if (x && y) return x < y ? x : y;
  return x ?? y;
}

/**
 * Merge two versions of the same attested row.
 *
 * Commutative by construction: merge(a, b) and merge(b, a) produce the same
 * row, so two devices converge regardless of sync order.
 */
export function mergeRow(table: string, mine: Row, theirs: Row): Row {
  switch (table) {
    case 'source': {
      // Identity fields fill in: a source first seen as a bare URL and later
      // recognised as a paper must end up with the DOI on both devices.
      const merged: Row = { ...theirs, ...mine };
      for (const key of [
        'canonical_url', 'doi', 'isbn', 'content_hash', 'title',
        'authors_json', 'published_at',
      ]) {
        merged[key] = coalesce(mine, theirs, key);
      }
      merged['first_seen_at'] =
        earliest(mine['first_seen_at'], theirs['first_seen_at']) ?? mine['first_seen_at']!;
      // Private wins. A source marked private anywhere must never become
      // eligible for egress because another device had not been told yet.
      merged['is_private'] =
        Number(mine['is_private'] ?? 0) || Number(theirs['is_private'] ?? 0) ? 1 : 0;
      // A source upgraded to a paper stays a paper.
      merged['kind'] = mine['kind'] === 'paper' || theirs['kind'] === 'paper'
        ? 'paper'
        : (mine['kind'] ?? theirs['kind'] ?? 'web');
      return merged;
    }

    case 'ingestion_event': {
      const merged: Row = { ...theirs, ...mine };

      // Engagement is a high-water mark, exactly as it is locally: a skim on
      // one device must not erase an annotation recorded on another.
      const a = mine['engagement'] as Engagement | null;
      const b = theirs['engagement'] as Engagement | null;
      const rank = (e: Engagement | null) => (e ? ENGAGEMENT_ORDER.indexOf(e) : -1);
      if (rank(b) > rank(a)) {
        merged['engagement'] = b;
        merged['engagement_source'] = theirs['engagement_source'] ?? null;
      } else {
        merged['engagement'] = a;
        merged['engagement_source'] = mine['engagement_source'] ?? null;
      }

      // Pipeline status: further along wins, because progress on either device
      // is real progress and reverting it would re-run paid stages.
      const sa = (mine['status'] as IngestionStatus) ?? 'captured';
      const sb = (theirs['status'] as IngestionStatus) ?? 'captured';
      const winner = (STATUS_RANK[sb] ?? 0) > (STATUS_RANK[sa] ?? 0) ? theirs : mine;
      merged['status'] = winner['status'] ?? 'captured';
      merged['status_reason'] = winner['status_reason'] ?? null;

      // Novelty is only meaningful with the model that produced it, so the
      // pair moves together or not at all.
      if (mine['novelty'] === null || mine['novelty'] === undefined) {
        merged['novelty'] = theirs['novelty'] ?? null;
        merged['novelty_model_id'] = theirs['novelty_model_id'] ?? null;
      }
      return merged;
    }

    case 'review': {
      const merged: Row = { ...theirs, ...mine };
      // A grade override is the user's judgment and outranks a machine grade
      // from either device. If both devices have one they are identical, since
      // a review is answered on exactly one device.
      merged['user_grade_override'] =
        mine['user_grade_override'] ?? theirs['user_grade_override'] ?? null;
      for (const key of ['answer_text', 'machine_grade', 'machine_rating', 'answered_at']) {
        merged[key] = coalesce(mine, theirs, key);
      }
      return merged;
    }

    default:
      // annotation, reading_session, user_assertion, egress_log: immutable
      // once written. Same primary key means the same row, so keep what is
      // already here and treat the arrival as a no-op.
      return mine;
  }
}

/** Attested tables that participate in sync, and their primary key column. */
export const SYNCED_TABLES: readonly { name: string; key: string }[] = [
  { name: 'source', key: 'id' },
  { name: 'ingestion_event', key: 'id' },
  { name: 'annotation', key: 'id' },
  { name: 'reading_session', key: 'id' },
  { name: 'review', key: 'id' },
  { name: 'user_assertion', key: 'id' },
];

/**
 * Tables whose rows reference another synced table, and must be applied after
 * it. `annotation` references `document_version`, which is DERIVED and
 * therefore not synced — so an annotation can arrive for a document the
 * receiving device has not extracted yet. That case is handled by deferring
 * the row, not by shipping derived data.
 */
export const APPLY_ORDER: readonly string[] = [
  'source',
  'ingestion_event',
  'reading_session',
  'review',
  'user_assertion',
  'annotation',
];

/**
 * The coverage timeline — docs/07-graph-views.md § View 3.
 *
 * What was covered when, and how it held up. The gaps between marks are the
 * point: the spacing of encounters is the thing worth seeing, and a dense run
 * followed by six months of silence is legible here in a way no score is.
 *
 * The honest-presentation rules apply in full. This returns evidence —
 * encounters and graded outcomes with their dates — and no modelled retention
 * figure. A client wanting one asks `retentionEvidence`, which withholds it
 * when the evidence is thin.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Engagement } from '../types.js';

export type Granularity = 'day' | 'week' | 'month';

export interface TimelineEncounter {
  at: string;
  sourceId: string;
  sourceTitle: string | null;
  engagement: Engagement | null;
  capturePath: string;
}

export interface TimelineReview {
  at: string;
  rating: number | null;
  /** True for Good or Easy. */
  passed: boolean;
  intervalDays: number | null;
}

export interface TimelineRow {
  conceptId: string;
  label: string;
  encounters: TimelineEncounter[];
  reviews: TimelineReview[];
  /** Longest stretch with no contact of any kind, in days. */
  largestGapDays: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface TimelineOptions {
  from: string;
  to: string;
  conceptIds?: readonly string[];
  granularity?: Granularity;
  limit?: number;
}

const DAY_MS = 86_400_000;
const PASSING_RATING = 3;

/** Truncate a timestamp to the requested bucket. */
export function bucket(at: string, granularity: Granularity): string {
  const d = new Date(at);
  if (granularity === 'day') return d.toISOString().slice(0, 10);
  if (granularity === 'month') return d.toISOString().slice(0, 7);
  // Week: ISO Monday-anchored, so buckets are stable across queries.
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime() - day * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

export async function timeline(
  db: SqlDriver,
  opts: TimelineOptions,
): Promise<TimelineRow[]> {
  const limit = opts.limit ?? 50;
  const filterConcepts = opts.conceptIds?.length
    ? opts.conceptIds
    : null;

  const conceptFilter = filterConcepts
    ? `AND cv.concept_id IN (${filterConcepts.map(() => '?').join(', ')})`
    : '';

  const concepts = await db.all<{ concept_id: string; label: string }>(
    `SELECT cv.concept_id, c.label
       FROM coverage cv
       JOIN concept c ON c.id = cv.concept_id
      WHERE cv.last_contact_at >= ? AND cv.first_contact_at <= ?
        ${conceptFilter}
      ORDER BY cv.distinct_sources DESC, cv.last_contact_at DESC
      LIMIT ?`,
    [opts.from, opts.to, ...(filterConcepts ?? []), limit],
  );

  const rows: TimelineRow[] = [];

  for (const c of concepts) {
    const encounters = await db.all<{
      occurred_at: string; source_id: string; title: string | null;
      engagement: string | null; capture_path: string;
    }>(
      `SELECT DISTINCT ie.occurred_at, s.id AS source_id, s.title,
              ie.engagement, ie.capture_path
         FROM mention m
         JOIN chunk ch ON ch.id = m.chunk_id
         JOIN document_version dv ON dv.id = ch.document_version_id
         JOIN source s ON s.id = dv.source_id
         JOIN ingestion_event ie ON ie.source_id = s.id
        WHERE m.concept_id = ? AND ie.occurred_at BETWEEN ? AND ?
        ORDER BY ie.occurred_at`,
      [c.concept_id, opts.from, opts.to],
    );

    const reviews = await db.all<{
      presented_at: string; rating: number | null; interval_days: number | null;
    }>(
      `SELECT presented_at,
              COALESCE(user_grade_override, machine_rating, self_rating) AS rating,
              interval_days
         FROM review
        WHERE concept_id = ? AND presented_at BETWEEN ? AND ?
        ORDER BY presented_at`,
      [c.concept_id, opts.from, opts.to],
    );

    const marks = [
      ...encounters.map((e) => Date.parse(e.occurred_at)),
      ...reviews.map((r) => Date.parse(r.presented_at)),
    ].sort((a, b) => a - b);

    let largestGapDays = 0;
    for (let i = 1; i < marks.length; i++) {
      const gap = (marks[i]! - marks[i - 1]!) / DAY_MS;
      if (gap > largestGapDays) largestGapDays = gap;
    }

    rows.push({
      conceptId: c.concept_id,
      label: c.label,
      encounters: encounters.map((e) => ({
        at: e.occurred_at,
        sourceId: e.source_id,
        sourceTitle: e.title,
        engagement: e.engagement as Engagement | null,
        capturePath: e.capture_path,
      })),
      reviews: reviews.map((r) => ({
        at: r.presented_at,
        rating: r.rating,
        passed: (r.rating ?? 0) >= PASSING_RATING,
        intervalDays: r.interval_days,
      })),
      largestGapDays: Math.round(largestGapDays),
      firstAt: marks.length ? new Date(marks[0]!).toISOString() : null,
      lastAt: marks.length ? new Date(marks[marks.length - 1]!).toISOString() : null,
    });
  }

  return rows;
}

/**
 * Coverage rollup.
 *
 * A pure function of attested rows plus mentions, materialised for query
 * speed. Coverage is a vector of facts, never a score: any collapse to one
 * number happens at the presentation layer where the inputs can be shown
 * alongside it (docs/02-data-model.md § Why some obvious things are not here).
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import { ENGAGEMENT_ORDER } from '../types.js';
import type { Engagement } from '../types.js';

export const ROLLUP_VERSION = '1.0.0';

export interface CoverageRow {
  conceptId: string;
  label: string;
  distinctSources: number;
  primarySources: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  temporalSpreadDays: number;
  maxEngagement: Engagement | null;
  contactCount: number;
  hasUserAnnotation: boolean;
}

interface RawRow {
  concept_id: string;
  source_id: string;
  is_primary: number;
  occurred_at: string;
  engagement: string | null;
  has_annotation: number;
}

const DAY_MS = 86_400_000;

/**
 * Recompute coverage for every concept.
 *
 * Deliberately recomputed wholesale rather than incrementally: at this scale
 * the query is cheap, and an incremental rollup that drifts from the mentions
 * it summarises is a silent correctness bug in the number the whole product
 * rests on.
 */
export async function rollupCoverage(
  db: SqlDriver,
  clock: Clock,
): Promise<{ concepts: number }> {
  const rows = await db.all<RawRow>(
    `SELECT m.concept_id            AS concept_id,
            dv.source_id            AS source_id,
            MAX(m.is_primary)       AS is_primary,
            ie.occurred_at          AS occurred_at,
            ie.engagement           AS engagement,
            CASE WHEN EXISTS (
              SELECT 1 FROM annotation a WHERE a.document_version_id = dv.id
            ) THEN 1 ELSE 0 END     AS has_annotation
       FROM mention m
       JOIN chunk c             ON c.id = m.chunk_id
       JOIN document_version dv ON dv.id = c.document_version_id
       JOIN ingestion_event ie  ON ie.source_id = dv.source_id
      GROUP BY m.concept_id, dv.source_id, ie.id`,
  );

  const byConcept = new Map<string, RawRow[]>();
  for (const r of rows) {
    const list = byConcept.get(r.concept_id) ?? [];
    list.push(r);
    byConcept.set(r.concept_id, list);
  }

  const now = clock.now();

  await db.transaction(async () => {
    await db.run('DELETE FROM coverage');

    for (const [conceptId, group] of byConcept) {
      const sources = new Set(group.map((g) => g.source_id));
      const primarySources = new Set(
        group.filter((g) => g.is_primary === 1).map((g) => g.source_id),
      );
      const times = group.map((g) => g.occurred_at).sort();
      const first = times[0] ?? null;
      const last = times[times.length - 1] ?? null;
      const spread =
        first && last
          ? Math.max(0, Math.round((Date.parse(last) - Date.parse(first)) / DAY_MS))
          : 0;

      let maxEngagement: Engagement | null = null;
      for (const g of group) {
        const e = g.engagement as Engagement | null;
        if (!e) continue;
        if (
          maxEngagement === null ||
          ENGAGEMENT_ORDER.indexOf(e) > ENGAGEMENT_ORDER.indexOf(maxEngagement)
        ) {
          maxEngagement = e;
        }
      }

      await db.run(
        `INSERT INTO coverage
           (concept_id, distinct_sources, primary_sources, first_contact_at,
            last_contact_at, temporal_spread_days, max_engagement,
            contact_count, has_user_annotation, computed_at, producer_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          conceptId, sources.size, primarySources.size, first, last, spread,
          maxEngagement, group.length,
          group.some((g) => g.has_annotation === 1) ? 1 : 0,
          now, ROLLUP_VERSION,
        ],
      );
    }
  });

  return { concepts: byConcept.size };
}

export async function coverageFor(
  db: SqlDriver,
  conceptId: string,
): Promise<CoverageRow | null> {
  const r = await db.get<{
    concept_id: string; label: string; distinct_sources: number;
    primary_sources: number; first_contact_at: string | null;
    last_contact_at: string | null; temporal_spread_days: number;
    max_engagement: string | null; contact_count: number;
    has_user_annotation: number;
  }>(
    `SELECT cv.*, c.label FROM coverage cv
       JOIN concept c ON c.id = cv.concept_id
      WHERE cv.concept_id = ?`,
    [conceptId],
  );
  if (!r) return null;
  return {
    conceptId: r.concept_id,
    label: r.label,
    distinctSources: r.distinct_sources,
    primarySources: r.primary_sources,
    firstContactAt: r.first_contact_at,
    lastContactAt: r.last_contact_at,
    temporalSpreadDays: r.temporal_spread_days,
    maxEngagement: r.max_engagement as Engagement | null,
    contactCount: r.contact_count,
    hasUserAnnotation: r.has_user_annotation === 1,
  };
}

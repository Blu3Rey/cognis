/**
 * The coverage queries that are the product.
 *
 * These are the success-test questions from docs/00-vision-and-scope.md,
 * promoted to first-class API calls. If these do not return results the user
 * recognises as real blind spots, M2 has not landed, whatever the graph looks
 * like.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Engagement } from '../types.js';

export interface ConceptGap {
  conceptId: string;
  label: string;
  scheme: string;
  distinctSources: number;
  primarySources: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  temporalSpreadDays: number;
  maxEngagement: Engagement | null;
  /** Sources that mention it, for the "tap through to the evidence" path. */
  sourceIds: string[];
}

export interface UncoveredOptions {
  /** Distinct sources that must mention it. */
  minDistinctSources?: number;
  /** Sources that may be ABOUT it. Zero means never covered directly. */
  maxPrimarySources?: number;
  limit?: number;
  /** Include `local:` concepts. Off by default — they are noisier. */
  includeLocal?: boolean;
}

/**
 * Concepts met from several independent sources but never covered directly.
 *
 * The single most valuable query in the system: the user keeps brushing
 * against something and has never read anything *about* it. It is also the
 * blind spot a reader cannot see unaided, which is the whole argument for
 * cognis over a search engine.
 */
export async function uncoveredButRecurring(
  db: SqlDriver,
  opts: UncoveredOptions = {},
): Promise<ConceptGap[]> {
  const minDistinct = opts.minDistinctSources ?? 3;
  const maxPrimary = opts.maxPrimarySources ?? 0;
  const limit = opts.limit ?? 25;
  const includeLocal = opts.includeLocal ?? false;

  const rows = await db.all<{
    concept_id: string; label: string; scheme: string;
    distinct_sources: number; primary_sources: number;
    first_contact_at: string | null; last_contact_at: string | null;
    temporal_spread_days: number; max_engagement: string | null;
  }>(
    `SELECT cv.concept_id, c.label, c.scheme, cv.distinct_sources,
            cv.primary_sources, cv.first_contact_at, cv.last_contact_at,
            cv.temporal_spread_days, cv.max_engagement
       FROM coverage cv
       JOIN concept c ON c.id = cv.concept_id
      WHERE cv.distinct_sources >= ?
        AND cv.primary_sources <= ?
        AND (? = 1 OR c.scheme <> 'local')
      ORDER BY cv.distinct_sources DESC, cv.temporal_spread_days DESC
      LIMIT ?`,
    [minDistinct, maxPrimary, includeLocal ? 1 : 0, limit],
  );

  const gaps: ConceptGap[] = [];
  for (const r of rows) {
    const sources = await db.all<{ source_id: string }>(
      `SELECT DISTINCT dv.source_id AS source_id
         FROM mention m
         JOIN chunk ch ON ch.id = m.chunk_id
         JOIN document_version dv ON dv.id = ch.document_version_id
        WHERE m.concept_id = ?`,
      [r.concept_id],
    );
    gaps.push({
      conceptId: r.concept_id,
      label: r.label,
      scheme: r.scheme,
      distinctSources: r.distinct_sources,
      primarySources: r.primary_sources,
      firstContactAt: r.first_contact_at,
      lastContactAt: r.last_contact_at,
      temporalSpreadDays: r.temporal_spread_days,
      maxEngagement: r.max_engagement as Engagement | null,
      sourceIds: sources.map((s) => s.source_id),
    });
  }
  return gaps;
}

export interface TaxonomyNode {
  conceptId: string;
  label: string;
  scheme: string;
  /** Null when the concept has no parent in the vocabulary. */
  parentId: string | null;
  distinctSources: number;
  primarySources: number;
  lastContactAt: string | null;
  /** True when nothing in the corpus covers it — a hole worth seeing. */
  uncovered: boolean;
}

/**
 * The taxonomy tree.
 *
 * Comes free from external anchoring: Wikidata subclass relations and MeSH
 * tree numbers are a real hierarchy, so no clustering heuristic is involved
 * and no model is consulted (docs/07-graph-views.md § View 2).
 */
export async function taxonomy(
  db: SqlDriver,
  opts: { rootConceptId?: string | null; includeUncovered?: boolean } = {},
): Promise<TaxonomyNode[]> {
  const includeUncovered = opts.includeUncovered ?? true;

  const rows = await db.all<{
    concept_id: string; label: string; scheme: string; parent_id: string | null;
    distinct_sources: number | null; primary_sources: number | null;
    last_contact_at: string | null;
  }>(
    `SELECT c.id AS concept_id, c.label, c.scheme,
            (SELECT e.to_concept FROM edge e
              WHERE e.from_concept = c.id
                AND e.relation = 'subclass_of'
                AND e.provenance = 'vocabulary'
              ORDER BY e.to_concept LIMIT 1) AS parent_id,
            cv.distinct_sources, cv.primary_sources, cv.last_contact_at
       FROM concept c
       LEFT JOIN coverage cv ON cv.concept_id = c.id
      ORDER BY c.label`,
  );

  let nodes: TaxonomyNode[] = rows.map((r) => ({
    conceptId: r.concept_id,
    label: r.label,
    scheme: r.scheme,
    parentId: r.parent_id,
    distinctSources: r.distinct_sources ?? 0,
    primarySources: r.primary_sources ?? 0,
    lastContactAt: r.last_contact_at,
    uncovered: (r.distinct_sources ?? 0) === 0,
  }));

  if (!includeUncovered) nodes = nodes.filter((n) => !n.uncovered);

  if (opts.rootConceptId) {
    const keep = new Set<string>([opts.rootConceptId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of nodes) {
        if (n.parentId && keep.has(n.parentId) && !keep.has(n.conceptId)) {
          keep.add(n.conceptId);
          grew = true;
        }
      }
    }
    nodes = nodes.filter((n) => keep.has(n.conceptId));
  }

  return nodes;
}

/** Concepts with no contact since a cutoff. Pairs with retention in M3. */
export async function staleCoverage(
  db: SqlDriver,
  opts: { before: string; limit?: number },
): Promise<ConceptGap[]> {
  const rows = await db.all<{
    concept_id: string; label: string; scheme: string;
    distinct_sources: number; primary_sources: number;
    first_contact_at: string | null; last_contact_at: string | null;
    temporal_spread_days: number; max_engagement: string | null;
  }>(
    `SELECT cv.concept_id, c.label, c.scheme, cv.distinct_sources,
            cv.primary_sources, cv.first_contact_at, cv.last_contact_at,
            cv.temporal_spread_days, cv.max_engagement
       FROM coverage cv
       JOIN concept c ON c.id = cv.concept_id
      WHERE cv.last_contact_at < ?
      ORDER BY cv.last_contact_at ASC
      LIMIT ?`,
    [opts.before, opts.limit ?? 25],
  );
  return rows.map((r) => ({
    conceptId: r.concept_id,
    label: r.label,
    scheme: r.scheme,
    distinctSources: r.distinct_sources,
    primarySources: r.primary_sources,
    firstContactAt: r.first_contact_at,
    lastContactAt: r.last_contact_at,
    temporalSpreadDays: r.temporal_spread_days,
    maxEngagement: r.max_engagement as Engagement | null,
    sourceIds: [],
  }));
}

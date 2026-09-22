/**
 * Suggestion ranking.
 *
 * The objective is the COVERAGE FRONTIER, not similarity. Nearest-neighbour
 * ranking recommends what most resembles what the user already has; applied
 * for a year it builds a filter bubble of one, which is a sad outcome for a
 * system whose purpose is breadth (docs/06-suggestion-engine.md).
 *
 * Two constraints are therefore structural rather than tunable: a cap on how
 * much of a slate may come from the user's largest cluster, and a serendipity
 * slot drawn from outside the top clusters. Neither has an engagement term,
 * and neither may acquire one — if relaxing diversity raised usage, that would
 * not be a reason to relax it.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import { ulid } from '../ids.js';
import { convergentReferences } from './citations.js';
import { bridgeGaps, taxonomyHoles, conceptClusters } from './structural.js';
import { uncoveredButRecurring } from '../coverage/queries.js';
import { neighbourCandidates } from './neighbours.js';
import type { Embedder } from '../ports/embedder.js';

export const RANKER_VERSION = '1.0.0';

export type SuggestionKind =
  | 'citation_gap' | 'coverage_gap' | 'bridge' | 'taxonomy_hole' | 'neighbour';

export interface SuggestionReason {
  kind: SuggestionKind;
  evidence: Record<string, unknown>;
}

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  conceptId: string | null;
  externalRef: string | null;
  title: string | null;
  /** Structured evidence. The client renders the sentence; core ships no prose. */
  reason: SuggestionReason;
  score: number;
  expiresAt: string;
}

export interface RankWeights {
  evidence: number;
  gap: number;
  reachability: number;
  redundancy: number;
}

export const DEFAULT_WEIGHTS: RankWeights = {
  evidence: 1.0,
  gap: 0.8,
  reachability: 0.3,
  redundancy: 0.6,
};

export interface GenerateSuggestionsOptions {
  limit?: number;
  weights?: RankWeights;
  /**
   * Hard cap on the fraction of a slate that may come from the user's largest
   * concept cluster. Structural, not a preference.
   */
  maxFromLargestClusterFraction?: number;
  /** Include one deliberately out-of-cluster item. */
  serendipity?: boolean;
  /** How long a slate stays valid. */
  ttlDays?: number;
  kinds?: readonly SuggestionKind[];
  /**
   * Required only to use the `neighbour` fallback. Absent means similarity
   * candidates are simply unavailable, which is an acceptable slate.
   */
  embedder?: Embedder;
}

interface Candidate {
  kind: SuggestionKind;
  conceptId: string | null;
  externalRef: string | null;
  title: string | null;
  reason: SuggestionReason;
  evidenceStrength: number;
  gap: number;
  reachability: number;
  redundancy: number;
  /** Which cluster this belongs to, for the diversity cap. */
  clusterId: number | null;
}

const DAY_MS = 86_400_000;

/**
 * Evidence strength by signal type.
 *
 * Convergent citation is ground truth from domain experts; embedding
 * similarity is a guess. Ordering them explicitly keeps the cheap, strong
 * signals ahead of the expensive, weak one.
 */
const EVIDENCE_BASE: Record<SuggestionKind, number> = {
  citation_gap: 1.0,
  coverage_gap: 0.85,
  bridge: 0.7,
  taxonomy_hole: 0.55,
  neighbour: 0.3,
};

async function dismissedTargets(db: SqlDriver): Promise<Set<string>> {
  const rows = await db.all<{ concept_id: string | null; external_ref: string | null }>(
    `SELECT concept_id, external_ref FROM suggestion WHERE dismissed_at IS NOT NULL`,
  );
  const notInterested = await db.all<{ subject_id: string }>(
    `SELECT subject_id FROM user_assertion
      WHERE kind IN ('not_interested','known_already')`,
  );
  const set = new Set<string>();
  for (const r of rows) {
    if (r.concept_id) set.add(r.concept_id);
    if (r.external_ref) set.add(r.external_ref);
  }
  for (const r of notInterested) set.add(r.subject_id);
  return set;
}

async function gatherCandidates(
  db: SqlDriver,
  kinds: readonly SuggestionKind[],
  clusterOf: Map<string, number>,
): Promise<Candidate[]> {
  const out: Candidate[] = [];

  if (kinds.includes('citation_gap')) {
    for (const ref of await convergentReferences(db, { minCiting: 2, limit: 40 })) {
      out.push({
        kind: 'citation_gap',
        conceptId: null,
        externalRef: ref.doi,
        title: ref.title,
        reason: {
          kind: 'citation_gap',
          evidence: {
            citingSourceIds: ref.citingSourceIds,
            citingCount: ref.citingCount,
            citedByCount: ref.citedByCount,
            publishedYear: ref.publishedYear,
            openAccess: ref.openAccess,
            yourCoverage: { distinctSources: 0, primarySources: 0 },
          },
        },
        // More converging sources is stronger evidence, saturating: the
        // difference between 2 and 5 citers matters more than 20 and 23.
        evidenceStrength: Math.min(1, Math.log2(1 + ref.citingCount) / 3),
        gap: 1,
        reachability: ref.openAccess ? 1 : 0.4,
        redundancy: 0,
        clusterId: null,
      });
    }
  }

  if (kinds.includes('coverage_gap')) {
    const gaps = await uncoveredButRecurring(db, {
      minDistinctSources: 2, maxPrimarySources: 0, limit: 40,
    });
    for (const g of gaps) {
      out.push({
        kind: 'coverage_gap',
        conceptId: g.conceptId,
        externalRef: null,
        title: g.label,
        reason: {
          kind: 'coverage_gap',
          evidence: {
            distinctSources: g.distinctSources,
            primarySources: g.primarySources,
            temporalSpreadDays: g.temporalSpreadDays,
            firstContactAt: g.firstContactAt,
            lastContactAt: g.lastContactAt,
            sourceIds: g.sourceIds,
          },
        },
        evidenceStrength: Math.min(1, g.distinctSources / 5),
        // Spread over months is a stronger gap than three hits in an afternoon.
        gap: Math.min(1, 0.5 + g.temporalSpreadDays / 180),
        reachability: 0.8,
        redundancy: 0,
        clusterId: clusterOf.get(g.conceptId) ?? null,
      });
    }
  }

  if (kinds.includes('bridge')) {
    for (const b of await bridgeGaps(db, { limit: 10 })) {
      out.push({
        kind: 'bridge',
        conceptId: b.clusterA.conceptIds[0] ?? null,
        externalRef: null,
        title: `${b.clusterA.labels[0] ?? '?'} ↔ ${b.clusterB.labels[0] ?? '?'}`,
        reason: {
          kind: 'bridge',
          evidence: {
            clusterA: b.clusterA.labels.slice(0, 5),
            clusterB: b.clusterB.labels.slice(0, 5),
            clusterAConceptIds: b.clusterA.conceptIds.slice(0, 5),
            clusterBConceptIds: b.clusterB.conceptIds.slice(0, 5),
            strength: b.strength,
          },
        },
        evidenceStrength: Math.min(1, b.strength / 25),
        gap: 1,
        reachability: 0.6,
        redundancy: 0,
        clusterId: null,
      });
    }
  }

  if (kinds.includes('taxonomy_hole')) {
    for (const h of await taxonomyHoles(db, { limit: 25 })) {
      out.push({
        kind: 'taxonomy_hole',
        conceptId: h.conceptId,
        externalRef: null,
        title: h.label,
        reason: {
          kind: 'taxonomy_hole',
          evidence: {
            viaConceptId: h.viaConceptId,
            viaLabel: h.viaLabel,
            relation: h.relation,
          },
        },
        evidenceStrength: 0.5,
        gap: 1,
        reachability: 0.8,
        redundancy: 0,
        clusterId: clusterOf.get(h.viaConceptId) ?? null,
      });
    }
  }

  return out;
}

function score(c: Candidate, w: RankWeights): number {
  return (
    w.evidence * EVIDENCE_BASE[c.kind] * c.evidenceStrength +
    w.gap * c.gap +
    w.reachability * c.reachability -
    w.redundancy * c.redundancy
  );
}

/**
 * Build and store a suggestion slate.
 *
 * Existing unexpired, undismissed suggestions are replaced: a slate is a
 * current report, not an accumulating feed.
 */
export async function generateSuggestions(
  db: SqlDriver,
  clock: Clock,
  opts: GenerateSuggestionsOptions = {},
): Promise<Suggestion[]> {
  const limit = opts.limit ?? 10;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const clusterCap = opts.maxFromLargestClusterFraction ?? 0.4;
  const serendipity = opts.serendipity ?? true;
  const ttlDays = opts.ttlDays ?? 14;
  const kinds = opts.kinds ?? (
    ['citation_gap', 'coverage_gap', 'bridge', 'taxonomy_hole'] as const
  );

  const clusters = await conceptClusters(db, { minSize: 1 });
  const clusterOf = new Map<string, number>();
  for (const cluster of clusters) {
    for (const id of cluster.conceptIds) clusterOf.set(id, cluster.id);
  }
  const largestClusterId = clusters[0]?.id ?? null;

  const dismissed = await dismissedTargets(db);
  const gathered = await gatherCandidates(db, kinds, clusterOf);

  // Embedding similarity is a last resort: it only runs when the structural
  // signals did not fill the slate, and it carries a redundancy penalty so it
  // can never outrank a citation or a coverage gap.
  if (kinds.includes('neighbour') && opts.embedder && gathered.length < limit) {
    for (const n of await neighbourCandidates(db, opts.embedder, { limit })) {
      gathered.push({
        kind: 'neighbour',
        conceptId: n.conceptId,
        externalRef: null,
        title: n.label,
        reason: {
          kind: 'neighbour',
          evidence: {
            nearConceptId: n.nearConceptId,
            nearLabel: n.nearLabel,
            similarity: Number(n.similarity.toFixed(3)),
            yourCoverage: { distinctSources: n.distinctSources },
            note: 'similarity-based: the weakest signal, shown because structural ones were thin',
          },
        },
        evidenceStrength: n.similarity,
        gap: 0.5,
        reachability: 0.7,
        // The penalty that keeps similarity from becoming the default.
        redundancy: n.similarity,
        clusterId: clusterOf.get(n.nearConceptId) ?? null,
      });
    }
  }

  const candidates = gathered.filter(
    (c) =>
      !(c.conceptId && dismissed.has(c.conceptId)) &&
      !(c.externalRef && dismissed.has(c.externalRef)),
  );

  const scored = candidates
    .map((c) => ({ c, s: score(c, weights) }))
    .sort((a, b) => b.s - a.s);

  const selected: { c: Candidate; s: number }[] = [];
  const maxFromLargest = Math.max(1, Math.floor(limit * clusterCap));
  let fromLargest = 0;
  const seen = new Set<string>();

  const keyOf = (c: Candidate) => `${c.kind}\u0000${c.conceptId ?? c.externalRef ?? ''}`;

  for (const entry of scored) {
    if (selected.length >= (serendipity ? limit - 1 : limit)) break;
    const key = keyOf(entry.c);
    if (seen.has(key)) continue;

    if (largestClusterId !== null && entry.c.clusterId === largestClusterId) {
      // The cap is a hard constraint. Without it the top of the ranking is
      // always the user's dominant interest, which is the bubble.
      if (fromLargest >= maxFromLargest) continue;
      fromLargest++;
    }

    seen.add(key);
    selected.push(entry);
  }

  if (serendipity && selected.length < limit) {
    // One item deliberately from outside the top clusters, drawn from
    // structural evidence rather than randomness, and labelled as such.
    const outside = scored.find(
      (e) =>
        !seen.has(keyOf(e.c)) &&
        e.c.clusterId !== largestClusterId &&
        (e.c.kind === 'bridge' || e.c.kind === 'taxonomy_hole'),
    ) ?? scored.find((e) => !seen.has(keyOf(e.c)));
    if (outside) {
      seen.add(keyOf(outside.c));
      selected.push(outside);
    }
  }

  const now = clock.now();
  const expiresAt = new Date(Date.parse(now) + ttlDays * DAY_MS).toISOString();

  const out: Suggestion[] = [];
  await db.transaction(async () => {
    // Replace the live slate; dismissals are preserved so they keep suppressing.
    await db.run('DELETE FROM suggestion WHERE dismissed_at IS NULL');

    for (const { c, s } of selected) {
      const id = ulid(clock.nowMs());
      await db.run(
        `INSERT INTO suggestion
           (id, kind, concept_id, external_ref, reason_json, score,
            generated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, c.kind, c.conceptId, c.externalRef,
          JSON.stringify(c.reason), s, now, expiresAt,
        ],
      );
      out.push({
        id, kind: c.kind, conceptId: c.conceptId, externalRef: c.externalRef,
        title: c.title, reason: c.reason, score: s, expiresAt,
      });
    }
  });

  return out;
}

/** Live suggestions: not dismissed, not expired. */
export async function activeSuggestions(
  db: SqlDriver,
  clock: Clock,
  opts: { limit?: number } = {},
): Promise<Suggestion[]> {
  const rows = await db.all<{
    id: string; kind: string; concept_id: string | null; external_ref: string | null;
    reason_json: string; score: number; expires_at: string; label: string | null;
  }>(
    `SELECT s.id, s.kind, s.concept_id, s.external_ref, s.reason_json, s.score,
            s.expires_at, c.label
       FROM suggestion s
       LEFT JOIN concept c ON c.id = s.concept_id
      WHERE s.dismissed_at IS NULL AND s.expires_at > ?
      ORDER BY s.score DESC
      LIMIT ?`,
    [clock.now(), opts.limit ?? 10],
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as SuggestionKind,
    conceptId: r.concept_id,
    externalRef: r.external_ref,
    title: r.label,
    reason: JSON.parse(r.reason_json) as SuggestionReason,
    score: r.score,
    expiresAt: r.expires_at,
  }));
}

export async function dismissSuggestion(
  db: SqlDriver,
  clock: Clock,
  id: string,
  reason?: 'not_interested' | 'already_known' | 'not_now',
): Promise<void> {
  await db.run(
    'UPDATE suggestion SET dismissed_at = ?, dismiss_reason = ? WHERE id = ?',
    [clock.now(), reason ?? null, id],
  );
}

/**
 * Structural gaps in the user's own corpus.
 *
 * No network, no model — SQL over mentions and coverage. These are the signals
 * similarity search will never surface, because they are about the *shape* of
 * what the user has read rather than its content
 * (docs/06 § Candidate sources, priority 2).
 */

import type { SqlDriver } from '../ports/sql.js';

export const STRUCTURAL_VERSION = '1.0.0';

/** Concepts co-occurring in a source, used to find clusters. */
export async function buildCooccurrence(
  db: SqlDriver,
  opts: { minShared?: number } = {},
): Promise<{ edges: number }> {
  const minShared = opts.minShared ?? 1;

  const rows = await db.all<{ a: string; b: string; shared: number }>(
    `SELECT ma.concept_id AS a, mb.concept_id AS b,
            COUNT(DISTINCT dv.source_id) AS shared
       FROM mention ma
       JOIN chunk ca ON ca.id = ma.chunk_id
       JOIN document_version dv ON dv.id = ca.document_version_id
       JOIN chunk cb ON cb.document_version_id = dv.id
       JOIN mention mb ON mb.chunk_id = cb.id
      WHERE ma.concept_id < mb.concept_id
      GROUP BY ma.concept_id, mb.concept_id
     HAVING COUNT(DISTINCT dv.source_id) >= ?`,
    [minShared],
  );

  await db.transaction(async () => {
    await db.run(`DELETE FROM edge WHERE provenance = 'corpus_stats'`);
    for (const r of rows) {
      // Recorded with corpus_stats provenance so the client never renders a
      // derived correlation the way it renders a vocabulary assertion.
      await db.run(
        `INSERT INTO edge
           (id, from_concept, to_concept, relation, provenance, weight, producer_version)
         VALUES (?, ?, ?, 'co_occurs', 'corpus_stats', ?, ?)
         ON CONFLICT (from_concept, to_concept, relation, provenance) DO NOTHING`,
        [`co_${r.a}_${r.b}`.slice(0, 120), r.a, r.b, r.shared, STRUCTURAL_VERSION],
      );
    }
  });

  return { edges: rows.length };
}

export interface ConceptCluster {
  id: number;
  conceptIds: string[];
  labels: string[];
  size: number;
}

/**
 * Connected components over the co-occurrence graph.
 *
 * A cluster is a region of the user's reading that hangs together. Two large
 * clusters with nothing bridging them is a gap worth naming.
 */
export async function conceptClusters(
  db: SqlDriver,
  opts: { minSize?: number } = {},
): Promise<ConceptCluster[]> {
  const minSize = opts.minSize ?? 2;

  const nodes = await db.all<{ id: string; label: string }>(
    `SELECT DISTINCT c.id, c.label
       FROM concept c
       JOIN mention m ON m.concept_id = c.id
      ORDER BY c.id`,
  );
  const edges = await db.all<{ from_concept: string; to_concept: string }>(
    `SELECT from_concept, to_concept FROM edge
      WHERE relation = 'co_occurs' AND provenance = 'corpus_stats'`,
  );

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression, so repeated lookups on a long chain stay cheap.
    let cur = x;
    while (parent.get(cur) !== undefined && parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const n of nodes) parent.set(n.id, n.id);
  for (const e of edges) {
    if (parent.has(e.from_concept) && parent.has(e.to_concept)) {
      union(e.from_concept, e.to_concept);
    }
  }

  const groups = new Map<string, { ids: string[]; labels: string[] }>();
  for (const n of nodes) {
    const root = find(n.id);
    const g = groups.get(root) ?? { ids: [], labels: [] };
    g.ids.push(n.id);
    g.labels.push(n.label);
    groups.set(root, g);
  }

  return [...groups.values()]
    .filter((g) => g.ids.length >= minSize)
    .map((g, i) => ({ id: i, conceptIds: g.ids, labels: g.labels, size: g.ids.length }))
    .sort((a, b) => b.size - a.size);
}

export interface BridgeGap {
  clusterA: { conceptIds: string[]; labels: string[] };
  clusterB: { conceptIds: string[]; labels: string[] };
  /** Product of cluster sizes: bigger unconnected regions matter more. */
  strength: number;
}

/**
 * Pairs of well-covered clusters that no single source touches.
 *
 * Interdisciplinary material connecting them is high value, and it is exactly
 * what nearest-neighbour search will never find, because the two regions are
 * by construction dissimilar.
 */
export async function bridgeGaps(
  db: SqlDriver,
  opts: { minClusterSize?: number; limit?: number } = {},
): Promise<BridgeGap[]> {
  const minSize = opts.minClusterSize ?? 2;
  const limit = opts.limit ?? 10;

  const clusters = await conceptClusters(db, { minSize });
  if (clusters.length < 2) return [];

  // A source touching both clusters would already bridge them. Connected
  // components guarantee no co-occurrence edge crosses, so any pair of
  // distinct clusters is unbridged by construction — ranked by joint size.
  const out: BridgeGap[] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i]!;
      const b = clusters[j]!;
      out.push({
        clusterA: { conceptIds: a.conceptIds, labels: a.labels },
        clusterB: { conceptIds: b.conceptIds, labels: b.labels },
        strength: a.size * b.size,
      });
    }
  }
  return out.sort((x, y) => y.strength - x.strength).slice(0, limit);
}

export interface TaxonomyHole {
  conceptId: string;
  label: string;
  /** The covered relative that makes this hole interesting. */
  viaConceptId: string;
  viaLabel: string;
  relation: 'sibling' | 'parent';
}

/**
 * Concepts adjacent in the vocabulary hierarchy to well-covered ones, with no
 * coverage at all. Free, non-generated, and directly renderable as the empty
 * children in the taxonomy view (docs/07 § View 2).
 */
export async function taxonomyHoles(
  db: SqlDriver,
  opts: { minCoveredSources?: number; limit?: number } = {},
): Promise<TaxonomyHole[]> {
  const minCovered = opts.minCoveredSources ?? 2;
  const limit = opts.limit ?? 25;

  const siblings = await db.all<{
    hole_id: string; hole_label: string; via_id: string; via_label: string;
  }>(
    `SELECT sib.id AS hole_id, sib.label AS hole_label,
            covered.id AS via_id, covered.label AS via_label
       FROM coverage cv
       JOIN concept covered ON covered.id = cv.concept_id
       JOIN edge e1 ON e1.from_concept = covered.id
                   AND e1.relation = 'subclass_of' AND e1.provenance = 'vocabulary'
       JOIN edge e2 ON e2.to_concept = e1.to_concept
                   AND e2.relation = 'subclass_of' AND e2.provenance = 'vocabulary'
       JOIN concept sib ON sib.id = e2.from_concept
      WHERE cv.distinct_sources >= ?
        AND sib.id <> covered.id
        AND NOT EXISTS (SELECT 1 FROM coverage c2 WHERE c2.concept_id = sib.id)
      GROUP BY sib.id, covered.id
      LIMIT ?`,
    [minCovered, limit],
  );

  return siblings.map((r) => ({
    conceptId: r.hole_id,
    label: r.hole_label,
    viaConceptId: r.via_id,
    viaLabel: r.via_label,
    relation: 'sibling' as const,
  }));
}

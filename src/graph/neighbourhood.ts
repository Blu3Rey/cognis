/**
 * The neighbourhood (ego) graph.
 *
 * cognis has no global graph view — "show me everything" is an explicit
 * non-feature (docs/07-graph-views.md). This is the bounded replacement: two
 * hops maximum, a hard node cap, and edges that carry their provenance so the
 * client can style a vocabulary assertion differently from a co-occurrence
 * statistic. Rendering them alike would present a derived correlation as an
 * asserted fact.
 */

import type { SqlDriver } from '../ports/sql.js';

export type EdgeProvenance = 'vocabulary' | 'citation_graph' | 'corpus_stats' | 'user';

export interface GraphNode {
  conceptId: string;
  label: string;
  scheme: string;
  /** Hops from the focal concept. */
  distance: number;
  distinctSources: number;
  primarySources: number;
  lastContactAt: string | null;
  /** Nothing in the corpus covers it — the visible coverage frontier. */
  uncovered: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  provenance: EdgeProvenance;
  weight: number | null;
}

export interface Neighbourhood {
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the cap dropped nodes, so the client can say so. */
  truncated: boolean;
}

export interface NeighbourhoodOptions {
  hops?: 1 | 2;
  /** Clamped to the rendering budget: a phone cannot lay out a hairball. */
  maxNodes?: number;
  minEdgeWeight?: number;
  provenances?: readonly EdgeProvenance[];
}

/** The rendering budget from docs/07. Core clamps; the client cannot exceed it. */
export const MAX_NEIGHBOURHOOD_NODES = 150;

export async function neighbourhood(
  db: SqlDriver,
  conceptId: string,
  opts: NeighbourhoodOptions = {},
): Promise<Neighbourhood> {
  const hops = opts.hops ?? 2;
  const maxNodes = Math.min(opts.maxNodes ?? MAX_NEIGHBOURHOOD_NODES, MAX_NEIGHBOURHOOD_NODES);
  const minWeight = opts.minEdgeWeight ?? 0;
  const provenances = opts.provenances ?? [
    'vocabulary', 'citation_graph', 'corpus_stats', 'user',
  ];

  const exists = await db.get<{ id: string }>('SELECT id FROM concept WHERE id = ?', [
    conceptId,
  ]);
  if (!exists) return { focus: conceptId, nodes: [], edges: [], truncated: false };

  const provPlaceholders = provenances.map(() => '?').join(', ');
  const distance = new Map<string, number>([[conceptId, 0]]);
  let frontier = [conceptId];

  for (let hop = 1; hop <= hops; hop++) {
    if (frontier.length === 0) break;
    const placeholders = frontier.map(() => '?').join(', ');
    const rows = await db.all<{ other: string }>(
      `SELECT DISTINCT other FROM (
         SELECT to_concept AS other FROM edge
          WHERE from_concept IN (${placeholders})
            AND provenance IN (${provPlaceholders})
            AND COALESCE(weight, 1) >= ?
         UNION
         SELECT from_concept AS other FROM edge
          WHERE to_concept IN (${placeholders})
            AND provenance IN (${provPlaceholders})
            AND COALESCE(weight, 1) >= ?
       )`,
      [
        ...frontier, ...provenances, minWeight,
        ...frontier, ...provenances, minWeight,
      ],
    );

    const next: string[] = [];
    for (const r of rows) {
      if (distance.has(r.other)) continue;
      distance.set(r.other, hop);
      next.push(r.other);
      // Stop expanding once the budget is spent rather than collecting
      // thousands of nodes and discarding them.
      if (distance.size >= maxNodes) break;
    }
    frontier = next;
    if (distance.size >= maxNodes) break;
  }

  const ids = [...distance.keys()];
  const idPlaceholders = ids.map(() => '?').join(', ');

  const nodeRows = await db.all<{
    id: string; label: string; scheme: string;
    distinct_sources: number | null; primary_sources: number | null;
    last_contact_at: string | null;
  }>(
    `SELECT c.id, c.label, c.scheme, cv.distinct_sources, cv.primary_sources,
            cv.last_contact_at
       FROM concept c
       LEFT JOIN coverage cv ON cv.concept_id = c.id
      WHERE c.id IN (${idPlaceholders})`,
    ids,
  );

  const nodes: GraphNode[] = nodeRows
    .map((r) => ({
      conceptId: r.id,
      label: r.label,
      scheme: r.scheme,
      distance: distance.get(r.id) ?? 0,
      distinctSources: r.distinct_sources ?? 0,
      primarySources: r.primary_sources ?? 0,
      lastContactAt: r.last_contact_at,
      uncovered: (r.distinct_sources ?? 0) === 0,
    }))
    .sort((a, b) => a.distance - b.distance || b.distinctSources - a.distinctSources);

  const kept = new Set(nodes.map((n) => n.conceptId));
  const edgeRows = await db.all<{
    from_concept: string; to_concept: string; relation: string;
    provenance: string; weight: number | null;
  }>(
    `SELECT from_concept, to_concept, relation, provenance, weight
       FROM edge
      WHERE from_concept IN (${idPlaceholders})
        AND to_concept IN (${idPlaceholders})
        AND provenance IN (${provPlaceholders})
        AND COALESCE(weight, 1) >= ?`,
    [...ids, ...ids, ...provenances, minWeight],
  );

  const edges: GraphEdge[] = edgeRows
    .filter((e) => kept.has(e.from_concept) && kept.has(e.to_concept))
    .map((e) => ({
      from: e.from_concept,
      to: e.to_concept,
      relation: e.relation,
      provenance: e.provenance as EdgeProvenance,
      weight: e.weight,
    }));

  return {
    focus: conceptId,
    nodes,
    edges,
    truncated: distance.size >= maxNodes,
  };
}

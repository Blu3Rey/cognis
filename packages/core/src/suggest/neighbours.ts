/**
 * Embedding neighbours — the last-resort candidate source.
 *
 * docs/06 is explicit: similarity is the wrong objective for breadth, and this
 * is what everyone builds first. It is used here only to fill a slate when the
 * structural signals are thin, and it carries a redundancy penalty so it never
 * outranks a citation or a coverage gap.
 *
 * The suggestion is a CONCEPT near what the user covers well but which they
 * have barely touched — not "more material like this", which is how a
 * recommender becomes a bubble.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Embedder } from '../ports/embedder.js';
import { cosine, fromBlob } from '../embed/vectors.js';

export interface NeighbourCandidate {
  conceptId: string;
  label: string;
  /** The well-covered concept it sits near. */
  nearConceptId: string;
  nearLabel: string;
  similarity: number;
  distinctSources: number;
}

/** Mean of a concept's mention-chunk vectors. */
async function centroid(
  db: SqlDriver,
  embedder: Embedder,
  conceptId: string,
): Promise<Float32Array | null> {
  const rows = await db.all<{ vector: Uint8Array }>(
    `SELECT DISTINCT v.vector AS vector
       FROM mention m
       JOIN embedding_vector v ON v.chunk_id = m.chunk_id AND v.model_id = ?
      WHERE m.concept_id = ?`,
    [embedder.modelId, conceptId],
  );
  if (rows.length === 0) return null;

  const sum = new Float32Array(embedder.dim);
  for (const r of rows) {
    const v = fromBlob(r.vector, embedder.dim);
    for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! + v[i]!;
  }
  let norm = 0;
  for (const x of sum) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! / norm;
  return sum;
}

export async function neighbourCandidates(
  db: SqlDriver,
  embedder: Embedder,
  opts: {
    wellCoveredMinSources?: number;
    thinMaxSources?: number;
    minSimilarity?: number;
    limit?: number;
  } = {},
): Promise<NeighbourCandidate[]> {
  const wellCovered = opts.wellCoveredMinSources ?? 2;
  const thin = opts.thinMaxSources ?? 1;
  const minSimilarity = opts.minSimilarity ?? 0.3;
  const limit = opts.limit ?? 10;

  const anchors = await db.all<{ concept_id: string; label: string }>(
    `SELECT cv.concept_id, c.label FROM coverage cv
       JOIN concept c ON c.id = cv.concept_id
      WHERE cv.distinct_sources >= ? AND c.scheme <> 'local'
      ORDER BY cv.distinct_sources DESC LIMIT 20`,
    [wellCovered],
  );
  const targets = await db.all<{ concept_id: string; label: string; n: number }>(
    `SELECT c.id AS concept_id, c.label,
            COALESCE(cv.distinct_sources, 0) AS n
       FROM concept c
       LEFT JOIN coverage cv ON cv.concept_id = c.id
      WHERE COALESCE(cv.distinct_sources, 0) <= ? AND c.scheme <> 'local'
      LIMIT 200`,
    [thin],
  );
  if (anchors.length === 0 || targets.length === 0) return [];

  const anchorVectors = new Map<string, Float32Array>();
  for (const a of anchors) {
    const v = await centroid(db, embedder, a.concept_id);
    if (v) anchorVectors.set(a.concept_id, v);
  }

  const out: NeighbourCandidate[] = [];
  for (const t of targets) {
    const tv = await centroid(db, embedder, t.concept_id);
    if (!tv) continue;

    let best: { id: string; label: string; sim: number } | null = null;
    for (const a of anchors) {
      if (a.concept_id === t.concept_id) continue;
      const av = anchorVectors.get(a.concept_id);
      if (!av) continue;
      const sim = cosine(tv, av);
      if (!best || sim > best.sim) best = { id: a.concept_id, label: a.label, sim };
    }
    if (!best || best.sim < minSimilarity) continue;

    out.push({
      conceptId: t.concept_id,
      label: t.label,
      nearConceptId: best.id,
      nearLabel: best.label,
      similarity: best.sim,
      distinctSources: t.n,
    });
  }

  return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

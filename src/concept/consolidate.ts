/**
 * Local concept consolidation.
 *
 * Local concepts accumulate duplicates by construction. Merging is proposed,
 * not silently applied, except above a high threshold — because a wrong merge
 * is far more damaging than a duplicate. A duplicate is visible and fixable; a
 * wrong merge destroys the distinction invisibly
 * (docs/04-concept-identity.md § Local concept merging).
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Embedder } from '../ports/embedder.js';
import { cosine, fromBlob } from '../embed/vectors.js';
import { loadOverrides, pairKey } from './overrides.js';

export interface MergeProposal {
  fromConceptId: string;
  toConceptId: string;
  fromLabel: string;
  toLabel: string;
  labelSimilarity: number;
  centroidSimilarity: number;
  /** True only above the auto threshold; everything else asks the user. */
  autoApplicable: boolean;
}

export interface ConsolidateOptions {
  /** Label similarity below this is never proposed. */
  minLabelSimilarity?: number;
  /** Centroid similarity below this is never proposed. */
  minCentroidSimilarity?: number;
  /** Both similarities above this may auto-merge. */
  autoThreshold?: number;
}

function normaliseLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Cheap morphological flattening: "embeddings" and "embedding" are the
    // same concept, and a duplicate pair that differs only by plural is the
    // single most common local-concept duplicate.
    .replace(/\b(\w+?)(?:ies)\b/g, '$1y')
    .replace(/\b(\w+?)(?:es|s)\b/g, '$1');
}

/** Token-set Jaccard. Cheap, order-insensitive, no dependency. */
function labelSimilarity(a: string, b: string): number {
  const ta = new Set(normaliseLabel(a).split(' ').filter(Boolean));
  const tb = new Set(normaliseLabel(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
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

export async function proposeMerges(
  db: SqlDriver,
  embedder: Embedder,
  opts: ConsolidateOptions = {},
): Promise<MergeProposal[]> {
  const minLabel = opts.minLabelSimilarity ?? 0.5;
  const minCentroid = opts.minCentroidSimilarity ?? 0.6;
  const auto = opts.autoThreshold ?? 0.9;

  const locals = await db.all<{ id: string; label: string }>(
    `SELECT id, label FROM concept WHERE scheme = 'local' ORDER BY id`,
  );
  if (locals.length < 2) return [];

  const overrides = await loadOverrides(db);
  const centroids = new Map<string, Float32Array | null>();
  for (const c of locals) centroids.set(c.id, await centroid(db, embedder, c.id));

  const proposals: MergeProposal[] = [];
  for (let i = 0; i < locals.length; i++) {
    for (let j = i + 1; j < locals.length; j++) {
      const a = locals[i]!;
      const b = locals[j]!;

      // The user already said these are different. Never propose it again.
      if (overrides.blockedMerges.has(pairKey(a.id, b.id))) continue;

      const labelSim = labelSimilarity(a.label, b.label);
      if (labelSim < minLabel) continue;

      const ca = centroids.get(a.id);
      const cb = centroids.get(b.id);
      if (!ca || !cb) continue;
      const centroidSim = cosine(ca, cb);
      if (centroidSim < minCentroid) continue;

      proposals.push({
        // Merge the later id into the earlier one, so the outcome does not
        // depend on iteration order.
        fromConceptId: b.id,
        toConceptId: a.id,
        fromLabel: b.label,
        toLabel: a.label,
        labelSimilarity: labelSim,
        centroidSimilarity: centroidSim,
        autoApplicable: labelSim >= auto && centroidSim >= auto,
      });
    }
  }

  return proposals.sort(
    (x, y) =>
      y.labelSimilarity + y.centroidSimilarity - (x.labelSimilarity + x.centroidSimilarity),
  );
}

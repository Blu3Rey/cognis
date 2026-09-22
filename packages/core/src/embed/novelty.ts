/**
 * Novelty at ingest.
 *
 *   novelty = 1 − max over this document's chunks of
 *             ( max cosine similarity against every other chunk in the corpus )
 *
 * Cheap, private, offline, and one of the more interesting numbers the system
 * produces: it answers "have I read something like this before?" before a
 * single paid model call. See docs/03-ingestion.md § Novelty at ingest.
 *
 * The score is meaningless without the model that produced it, so it is always
 * written together with `novelty_model_id` — a schema CHECK enforces that.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Embedder } from '../ports/embedder.js';
import type { Ulid } from '../types.js';
import { fromBlob, cosine } from './vectors.js';
import { scanVectors } from './store.js';

export interface NoveltyResult {
  /** 1 = nothing like it in the corpus; 0 = an exact match already present. */
  novelty: number;
  modelId: string;
  /** The most similar existing chunk, when there was one. */
  nearest: { chunkId: string; similarity: number } | null;
  /** False when the corpus held nothing to compare against. */
  comparable: boolean;
}

/**
 * Compute novelty for a document version against the rest of the corpus.
 *
 * The document's own chunks are excluded, otherwise every document is a
 * perfect match for itself and novelty is always zero.
 */
export async function computeNovelty(
  db: SqlDriver,
  embedder: Embedder,
  documentVersionId: Ulid,
): Promise<NoveltyResult> {
  const own = await db.all<{ id: string; vector: Uint8Array }>(
    `SELECT c.id AS id, v.vector AS vector
       FROM chunk c
       JOIN embedding_vector v ON v.chunk_id = c.id AND v.model_id = ?
      WHERE c.document_version_id = ?`,
    [embedder.modelId, documentVersionId],
  );

  if (own.length === 0) {
    return { novelty: 1, modelId: embedder.modelId, nearest: null, comparable: false };
  }

  const ownIds = new Set(own.map((r) => r.id));
  const ownVectors = own.map((r) => fromBlob(r.vector, embedder.dim));

  let best = -1;
  let bestChunk: string | null = null;

  for await (const batch of scanVectors(db, {
    modelId: embedder.modelId,
    dim: embedder.dim,
    excludeChunkIds: ownIds,
  })) {
    for (const other of batch) {
      for (const mine of ownVectors) {
        const sim = cosine(mine, other.vector);
        if (sim > best) {
          best = sim;
          bestChunk = other.chunkId;
        }
      }
    }
  }

  if (bestChunk === null) {
    // First document in the corpus: nothing to be novel against.
    return { novelty: 1, modelId: embedder.modelId, nearest: null, comparable: false };
  }

  // Similarity can be negative; novelty is reported on [0, 1] because the
  // schema constrains it there and "less similar than orthogonal" is not a
  // meaningful further distinction for this purpose.
  const similarity = Math.max(0, best);
  return {
    novelty: 1 - similarity,
    modelId: embedder.modelId,
    nearest: { chunkId: bestChunk, similarity: best },
    comparable: true,
  };
}

/**
 * Persist novelty onto an ingestion event.
 *
 * Only written when comparable: a novelty of 1 because the corpus was empty is
 * not the same claim as a novelty of 1 against 10,000 chunks, and recording
 * the former as though it were the latter would be a lie the UI then repeats.
 */
export async function recordNovelty(
  db: SqlDriver,
  ingestionEventId: Ulid,
  result: NoveltyResult,
): Promise<{ recorded: boolean }> {
  if (!result.comparable) return { recorded: false };
  await db.run(
    'UPDATE ingestion_event SET novelty = ?, novelty_model_id = ? WHERE id = ?',
    [result.novelty, result.modelId, ingestionEventId],
  );
  return { recorded: true };
}

/**
 * Chunk-and-embed pipeline, and the re-embed rebuild.
 *
 * Both stages are derived (docs/02-data-model.md): re-chunking or re-embedding
 * deletes this stage's output for the affected scope and recomputes it, never
 * touching an attested row.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type { Embedder } from '../ports/embedder.js';
import type { Ulid } from '../types.js';
import { ulid } from '../ids.js';
import { chunkText, CHUNKER_VERSION } from '../chunk/chunker.js';
import type { ChunkOptions } from '../chunk/chunker.js';
import { putVector } from './store.js';

export interface ChunkAndEmbedResult {
  documentVersionId: Ulid;
  chunkIds: Ulid[];
  modelId: string;
  chunksCreated: number;
  vectorsCreated: number;
}

/**
 * Chunk a document version and embed its chunks.
 *
 * Idempotent per (document version, chunker version) and per (chunk, model):
 * re-running replaces this stage's rows rather than accumulating duplicates.
 */
export async function chunkAndEmbed(
  db: SqlDriver,
  clock: Clock,
  embedder: Embedder,
  documentVersionId: Ulid,
  opts: ChunkOptions = {},
): Promise<ChunkAndEmbedResult> {
  const doc = await db.get<{ id: string; text: string }>(
    'SELECT id, text FROM document_version WHERE id = ?',
    [documentVersionId],
  );
  if (!doc) throw new Error(`no such document version: ${documentVersionId}`);

  const pieces = chunkText(doc.text, opts);

  return db.transaction(async () => {
    // Scoped rebuild: drop this document's chunks (cascading to its vectors)
    // and recompute. Attested rows are untouched.
    await db.run('DELETE FROM chunk WHERE document_version_id = ?', [documentVersionId]);

    const chunkIds: Ulid[] = [];
    for (const piece of pieces) {
      const id = ulid(clock.nowMs());
      chunkIds.push(id);
      await db.run(
        `INSERT INTO chunk
           (id, document_version_id, ordinal, start_char, end_char, text,
            section_path, producer_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, documentVersionId, piece.ordinal, piece.startChar, piece.endChar,
          piece.text, piece.sectionPath, CHUNKER_VERSION,
        ],
      );
    }

    const vectors = await embedder.embed(pieces.map((p) => p.text));
    if (vectors.length !== pieces.length) {
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${pieces.length} chunks`,
      );
    }

    const now = clock.now();
    for (let i = 0; i < chunkIds.length; i++) {
      const vec = vectors[i]!;
      if (vec.length !== embedder.dim) {
        throw new Error(
          `embedder declares dim ${embedder.dim} but returned ${vec.length}`,
        );
      }
      await putVector(db, chunkIds[i]!, embedder.modelId, embedder.dim, now, vec);
    }

    return {
      documentVersionId,
      chunkIds,
      modelId: embedder.modelId,
      chunksCreated: chunkIds.length,
      vectorsCreated: chunkIds.length,
    };
  });
}

export interface ReembedReport {
  modelId: string;
  documentVersions: number;
  chunks: number;
  vectors: number;
  removedVectorsForModel: number;
}

/**
 * Re-embed the whole corpus with an embedder.
 *
 * This is the rebuild machinery exercised early and deliberately: embedding
 * models change, and the whole attested/derived split exists so that change is
 * a recompute rather than a crisis. Raw text is kept permanently for exactly
 * this reason (docs/02 § Retention of the raw).
 */
export async function reembedAll(
  db: SqlDriver,
  clock: Clock,
  embedder: Embedder,
  opts: ChunkOptions = {},
): Promise<ReembedReport> {
  const docs = await db.all<{ id: string }>(
    'SELECT id FROM document_version ORDER BY id',
  );

  const priorRow = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM embedding_vector WHERE model_id = ?',
    [embedder.modelId],
  );
  const removed = priorRow?.n ?? 0;

  let chunks = 0;
  for (const d of docs) {
    const res = await chunkAndEmbed(db, clock, embedder, d.id, opts);
    chunks += res.chunksCreated;
  }

  return {
    modelId: embedder.modelId,
    documentVersions: docs.length,
    chunks,
    vectors: chunks,
    removedVectorsForModel: removed,
  };
}

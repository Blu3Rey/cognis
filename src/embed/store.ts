/**
 * Vector persistence and scanning.
 *
 * The scan is batched rather than loading the corpus into memory: a year of
 * reading is tens of thousands of chunks, and a phone cannot hold all of them
 * at once. A device build replaces `scanVectors` with a sqlite-vec ANN query;
 * everything above this file is unchanged by that swap.
 */

import type { SqlDriver } from '../ports/sql.js';
import { fromBlob, toBlob } from './vectors.js';

export interface StoredVector {
  chunkId: string;
  vector: Float32Array;
}

export interface ScanOptions {
  modelId: string;
  dim: number;
  /** Rows per batch. Bounds peak memory during a full scan. */
  batchSize?: number;
  /** Chunk ids to skip — used to exclude a document from its own novelty. */
  excludeChunkIds?: ReadonlySet<string>;
  /** Restrict the scan to chunks of these document versions. */
  documentVersionIds?: readonly string[];
}

export async function putVector(
  db: SqlDriver,
  chunkId: string,
  modelId: string,
  dim: number,
  computedAt: string,
  vector: Float32Array,
): Promise<void> {
  await db.run(
    `INSERT INTO embedding_meta (chunk_id, model_id, dim, computed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (chunk_id, model_id)
       DO UPDATE SET dim = excluded.dim, computed_at = excluded.computed_at`,
    [chunkId, modelId, dim, computedAt],
  );
  await db.run(
    `INSERT INTO embedding_vector (chunk_id, model_id, vector)
     VALUES (?, ?, ?)
     ON CONFLICT (chunk_id, model_id) DO UPDATE SET vector = excluded.vector`,
    [chunkId, modelId, toBlob(vector)],
  );
}

/**
 * Stream stored vectors for one model, in batches.
 *
 * Yields batches rather than individual vectors so the caller can do the
 * similarity arithmetic in a tight loop without per-row overhead.
 */
export async function* scanVectors(
  db: SqlDriver,
  opts: ScanOptions,
): AsyncGenerator<StoredVector[]> {
  const batchSize = opts.batchSize ?? 512;
  const exclude = opts.excludeChunkIds;

  let after = '';
  for (;;) {
    let sql = `SELECT v.chunk_id AS chunk_id, v.vector AS vector
                 FROM embedding_vector v`;
    const params: (string | number)[] = [];

    if (opts.documentVersionIds?.length) {
      const placeholders = opts.documentVersionIds.map(() => '?').join(', ');
      sql += ` JOIN chunk c ON c.id = v.chunk_id
               WHERE v.model_id = ? AND v.chunk_id > ?
                 AND c.document_version_id IN (${placeholders})`;
      params.push(opts.modelId, after, ...opts.documentVersionIds);
    } else {
      sql += ` WHERE v.model_id = ? AND v.chunk_id > ?`;
      params.push(opts.modelId, after);
    }
    sql += ` ORDER BY v.chunk_id LIMIT ?`;
    params.push(batchSize);

    const rows = await db.all<{ chunk_id: string; vector: Uint8Array }>(sql, params);
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.chunk_id;

    const batch: StoredVector[] = [];
    for (const r of rows) {
      if (exclude?.has(r.chunk_id)) continue;
      batch.push({ chunkId: r.chunk_id, vector: fromBlob(r.vector, opts.dim) });
    }
    if (batch.length > 0) yield batch;
  }
}

/** Count stored vectors for a model. */
export async function vectorCount(db: SqlDriver, modelId: string): Promise<number> {
  const row = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM embedding_vector WHERE model_id = ?',
    [modelId],
  );
  return row?.n ?? 0;
}

/**
 * `cognis index` — chunk, embed and score novelty for anything not yet done.
 *
 * Separate from ingest because these are the expensive, deferrable stages
 * (docs/03 § Scheduling and cost control), and because re-running them after
 * switching embedding model is a normal operation rather than an exception.
 */

import type { Cognis } from '@cognis/core';

export interface IndexReport {
  considered: number;
  indexed: number;
  skipped: number;
  chunks: number;
  failures: { documentVersionId: string; reason: string }[];
}

export async function indexPending(
  cognis: Cognis,
  opts: { all?: boolean; limit?: number } = {},
): Promise<IndexReport> {
  if (!cognis.embedder) {
    throw new Error('indexing needs an embedder; run with --embedder hash or install the model');
  }

  // Documents with no vectors for THIS model. Switching models makes every
  // document pending again, which is the correct behaviour: vectors from
  // different models are not comparable.
  const rows = await cognis.db.all<{ id: string; event_id: string | null }>(
    `SELECT dv.id AS id,
            (SELECT ie.id FROM ingestion_event ie
              WHERE ie.source_id = dv.source_id
              ORDER BY ie.occurred_at DESC LIMIT 1) AS event_id
       FROM document_version dv
      WHERE ? = 1
         OR NOT EXISTS (
              SELECT 1 FROM chunk c
                JOIN embedding_meta em ON em.chunk_id = c.id AND em.model_id = ?
               WHERE c.document_version_id = dv.id
            )
      ORDER BY dv.id
      LIMIT ?`,
    [opts.all ? 1 : 0, cognis.embedder.modelId, opts.limit ?? 1000],
  );

  const report: IndexReport = {
    considered: rows.length, indexed: 0, skipped: 0, chunks: 0, failures: [],
  };

  for (const row of rows) {
    try {
      if (row.event_id) {
        const res = await cognis.indexDocument({
          documentVersionId: row.id,
          ingestionEventId: row.event_id,
        });
        report.chunks += res.indexed.chunksCreated;
      } else {
        // No ingestion event to attach novelty to: chunk and embed anyway, so
        // the document is searchable.
        const res = await cognis.chunkAndEmbed(row.id);
        report.chunks += res.chunksCreated;
      }
      report.indexed++;
    } catch (err) {
      report.failures.push({
        documentVersionId: row.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  report.skipped = report.considered - report.indexed - report.failures.length;
  return report;
}

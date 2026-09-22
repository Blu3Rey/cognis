/**
 * Derived data must be droppable and rebuildable from attested rows alone.
 * This is the invariant that makes model churn a recompute rather than a
 * migration crisis (docs/adr/0002-attested-vs-derived.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';
import { HashEmbedder } from '../src/adapters/hash-embedder.js';
import { Cognis } from '../src/core.js';
import { NodeSqliteDriver } from '../src/adapters/node-sqlite.js';
import { FakeClock } from '../src/ports/clock.js';
import { REBUILDABLE_TABLES } from '../src/export/tables.js';

const TEXTS = [
  'Spaced repetition improves retention across domains.',
  'Retrieval practice beats rereading for durable memory.',
  'Sourdough fermentation depends on wild yeast activity.',
];

test('dropping every derived chunk and vector loses nothing recoverable', async () => {
  const { cognis } = await freshCognis();
  for (const [i, text] of TEXTS.entries()) {
    await ingest(cognis, `https://example.com/${i}`, text);
  }

  const before = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk');
  assert.ok(before!.n > 0);

  // Simulate total loss of the derived layer.
  for (const table of REBUILDABLE_TABLES) {
    await cognis.db.run(`DELETE FROM ${table}`);
  }
  assert.equal(
    (await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk'))!.n,
    0,
  );

  const report = await cognis.reembedAll();
  assert.equal(report.documentVersions, TEXTS.length);
  assert.equal(
    (await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk'))!.n,
    before!.n,
    'rebuild must restore the same number of chunks',
  );

  const hits = await cognis.search('memory retention');
  assert.ok(hits.length > 0, 'search must work again after a rebuild');
  await cognis.close();
});

test('re-embedding with a different model replaces vectors and keeps chunks', async () => {
  const { cognis } = await freshCognis();
  for (const [i, text] of TEXTS.entries()) {
    await ingest(cognis, `https://example.com/${i}`, text);
  }
  const chunksBefore = await cognis.db.all<{ id: string }>(
    'SELECT id FROM chunk ORDER BY ordinal',
  );

  const wider = new HashEmbedder({ dim: 256, modelId: 'hash-embedder-v1@256' });
  const cognis2 = new Cognis({ db: cognis.db, clock: cognis.clock, embedder: wider });
  const report = await cognis2.reembedAll();

  assert.equal(report.modelId, 'hash-embedder-v1@256');
  assert.equal(report.removedVectorsForModel, 0, 'the new model had no prior vectors');

  const dims = await cognis.db.all<{ model_id: string; dim: number }>(
    'SELECT DISTINCT model_id, dim FROM embedding_meta ORDER BY model_id',
  );
  assert.ok(dims.some((d) => d.model_id === 'hash-embedder-v1@256' && d.dim === 256));

  // Chunk count is a property of the chunker, not the embedder.
  const chunksAfter = await cognis.db.all<{ id: string }>('SELECT id FROM chunk');
  assert.equal(chunksAfter.length, chunksBefore.length);

  assert.ok((await cognis2.search('memory')).length > 0);
  await cognis.close();
});

test('chunking is idempotent: re-running replaces rather than accumulating', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', TEXTS[0]!);

  const first = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk');
  await cognis.chunkAndEmbed(doc.documentVersionId);
  await cognis.chunkAndEmbed(doc.documentVersionId);
  const after = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk');

  assert.equal(after!.n, first!.n);
  const vectors = await cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM embedding_vector',
  );
  assert.equal(vectors!.n, first!.n, 'orphaned vectors would skew every search');
  await cognis.close();
});

test('deleting a source removes its chunks and vectors', async () => {
  const { cognis } = await freshCognis();
  const a = await ingest(cognis, 'https://example.com/a', TEXTS[0]!);
  await ingest(cognis, 'https://example.com/b', TEXTS[1]!);

  await cognis.deleteSource(a.sourceId);

  const orphanChunks = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM chunk
      WHERE document_version_id NOT IN (SELECT id FROM document_version)`,
  );
  const orphanVectors = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM embedding_vector
      WHERE chunk_id NOT IN (SELECT id FROM chunk)`,
  );
  assert.equal(orphanChunks!.n, 0);
  assert.equal(orphanVectors!.n, 0);
  await cognis.close();
});

test('an unmigrated database is rebuilt from an export alone', async () => {
  const { cognis } = await freshCognis();
  for (const [i, text] of TEXTS.entries()) {
    await ingest(cognis, `https://example.com/${i}`, text);
  }
  const exported = await cognis.exportJsonlString();
  await cognis.close();

  const restored = new Cognis({
    db: new NodeSqliteDriver(),
    clock: new FakeClock('2026-06-01T00:00:00.000Z'),
    embedder: new HashEmbedder(),
  });
  await restored.migrate();
  await restored.importJsonlString(exported);

  // The export carries no vectors; the importing device regenerates them.
  assert.equal(
    (await restored.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk'))!.n,
    0,
  );
  await restored.reembedAll();
  assert.ok((await restored.search('memory retention')).length > 0);
  await restored.close();
});

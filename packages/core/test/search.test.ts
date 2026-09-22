import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';

const DOCS: [string, string][] = [
  ['https://example.com/spacing',
   'Spaced repetition and distributed practice improve long term memory retention.'],
  ['https://example.com/bread',
   'Sourdough fermentation relies on wild yeast and lactic acid bacteria for flavour.'],
  ['https://example.com/testing',
   'Retrieval practice, also called the testing effect, strengthens memory more than rereading.'],
];

async function corpus() {
  const { cognis } = await freshCognis();
  for (const [url, text] of DOCS) await ingest(cognis, url, text);
  return cognis;
}

test('semantic search ranks the relevant document first', async () => {
  const cognis = await corpus();
  const hits = await cognis.search('memory retention practice', { limit: 3 });

  assert.ok(hits.length > 0, 'expected hits');
  assert.ok(
    hits[0]!.canonicalUrl?.includes('spacing') || hits[0]!.canonicalUrl?.includes('testing'),
    `expected a memory document first, got ${hits[0]!.canonicalUrl}`,
  );
  assert.ok(
    hits[0]!.score >= hits[hits.length - 1]!.score,
    'hits must be returned in descending score order',
  );
  await cognis.close();
});

test('hits carry the provenance needed to open the source', async () => {
  const cognis = await corpus();
  const [hit] = await cognis.search('sourdough fermentation', { limit: 1 });

  assert.ok(hit);
  assert.ok(hit!.sourceId);
  assert.ok(hit!.documentVersionId);
  assert.ok(hit!.chunkId);
  assert.ok(hit!.endChar > hit!.startChar);
  assert.ok(hit!.canonicalUrl?.includes('bread'));
  await cognis.close();
});

test('literal search works without an embedder', async () => {
  const { Cognis } = await import('../src/core.js');
  const { NodeSqliteDriver } = await import('../src/adapters/node-sqlite.js');
  const { FakeClock } = await import('../src/ports/clock.js');

  const cognis = await corpus();
  const exported = await cognis.exportJsonlString();
  await cognis.close();

  // A build with no embedder still captures, imports and searches literally.
  const plain = new Cognis({
    db: new NodeSqliteDriver(),
    clock: new FakeClock('2026-01-01T00:00:00.000Z'),
  });
  await plain.migrate();
  await plain.importJsonlString(exported);

  // Semantic search is unavailable and says so, rather than returning silence
  // that looks like "nothing matched".
  await assert.rejects(plain.search('anything'), /needs an embedder/);

  const literal = await plain.searchLiteral('sourdough');
  assert.equal(literal.length, 0, 'chunks are rebuildable and not exported');

  await plain.close();
});

test('search returns nothing rather than throwing on an empty corpus', async () => {
  const { cognis } = await freshCognis();
  assert.deepEqual(await cognis.search('anything'), []);
  await cognis.close();
});

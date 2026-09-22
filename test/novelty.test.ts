import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';

const SPACING = `Spaced repetition strengthens memory. Distributing practice over
time produces more durable retention than massing the same practice together.`;

const SPACING_AGAIN = `Distributing practice over time produces more durable
retention than massing the same practice. Spaced repetition strengthens memory.`;

const UNRELATED = `Sourdough fermentation depends on wild yeast and lactic acid
bacteria. Hydration ratio and ambient temperature govern the crumb structure.`;

test('the first document in an empty corpus is not scored as novel', async () => {
  const { cognis } = await freshCognis();
  const first = await ingest(cognis, 'https://example.com/a', SPACING);

  const novelty = await cognis.computeNovelty(first.documentVersionId);
  assert.equal(novelty.comparable, false);

  // A novelty of 1 against an empty corpus is not the same claim as a novelty
  // of 1 against thousands of chunks, so nothing is recorded.
  const row = await cognis.db.get<{ novelty: number | null }>(
    'SELECT novelty FROM ingestion_event WHERE id = ?',
    [first.ingestionEventId],
  );
  assert.equal(row?.novelty, null);
  await cognis.close();
});

test('near-duplicate material scores low novelty, unrelated material high', async () => {
  const { cognis } = await freshCognis();
  await ingest(cognis, 'https://example.com/a', SPACING);

  const dup = await ingest(cognis, 'https://example.com/b', SPACING_AGAIN);
  const unrelated = await ingest(cognis, 'https://example.com/c', UNRELATED);

  const dupNovelty = await cognis.computeNovelty(dup.documentVersionId);
  const unrelatedNovelty = await cognis.computeNovelty(unrelated.documentVersionId);

  assert.equal(dupNovelty.comparable, true);
  assert.ok(
    dupNovelty.novelty < unrelatedNovelty.novelty,
    `restatement (${dupNovelty.novelty}) should be less novel than unrelated ` +
      `material (${unrelatedNovelty.novelty})`,
  );
  await cognis.close();
});

test('novelty is recorded with the model that produced it', async () => {
  const { cognis } = await freshCognis();
  await ingest(cognis, 'https://example.com/a', SPACING);
  const second = await ingest(cognis, 'https://example.com/b', UNRELATED);

  const row = await cognis.db.get<{ novelty: number; novelty_model_id: string }>(
    'SELECT novelty, novelty_model_id FROM ingestion_event WHERE id = ?',
    [second.ingestionEventId],
  );
  assert.ok(row);
  assert.ok(row!.novelty >= 0 && row!.novelty <= 1);
  assert.equal(row!.novelty_model_id, cognis.embedder!.modelId);
  await cognis.close();
});

test('a document is not compared against its own chunks', async () => {
  const { cognis } = await freshCognis();
  await ingest(cognis, 'https://example.com/a', SPACING);
  const b = await ingest(cognis, 'https://example.com/b', UNRELATED);

  const n = await cognis.computeNovelty(b.documentVersionId);
  // Self-comparison would make every document a perfect match for itself.
  assert.ok(n.novelty > 0, 'self-match would drive novelty to zero');
  assert.notEqual(n.nearest, null);
  await cognis.close();
});

test('the share-time card reports prior coverage and novelty together', async () => {
  const { cognis, clock } = await freshCognis();
  // Something must already be in the corpus, otherwise there is nothing for
  // the spacing article to be novel against and no score is recorded.
  await ingest(cognis, 'https://example.com/bread', UNRELATED);
  await ingest(cognis, 'https://example.com/spacing-1', SPACING);

  clock.advanceDays(40);
  const revisit = await cognis.capture({
    kind: 'url', payload: 'https://example.com/spacing-1', capturePath: 'share_sheet',
  });

  // "Have I seen this before?" — answered from attested rows, offline.
  assert.equal(revisit.priorCoverage.seenBefore, true);
  assert.equal(revisit.priorCoverage.previousEvents.length, 1);
  assert.notEqual(
    revisit.priorCoverage.novelty, null,
    'the earlier encounter carried a novelty score, so the card must show it',
  );
  await cognis.close();
});

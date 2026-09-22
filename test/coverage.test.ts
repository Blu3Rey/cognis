import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';

/**
 * Three sources that all mention spaced repetition in passing, and none that
 * is about it. This is the shape of a real blind spot, and the first question
 * in the success test (docs/00 § The falsifiable success test).
 */
const PASSING = [
  ['https://example.com/tools', 'Anki implements spaced repetition. The app is written in Python and Rust.'],
  ['https://example.com/habits', 'Habit formation is slow. Some people use spaced repetition for vocabulary.'],
  ['https://example.com/notes', 'Note-taking systems vary. A few integrate spaced repetition for review.'],
] as const;

async function corpusWithGap() {
  const { cognis, clock } = await freshCognis();
  for (const [url, text] of PASSING) {
    clock.advanceDays(20);
    const doc = await ingest(cognis, url, text, 'Tooling notes');
    await cognis.linkDocument(doc.documentVersionId);
  }
  await cognis.rollupCoverage();
  return { cognis, clock };
}

test('coverage counts distinct sources and separates primary from passing', async () => {
  const { cognis } = await corpusWithGap();
  const cov = await cognis.coverageFor('wd:Q1049444');

  assert.ok(cov, 'expected coverage for spaced repetition');
  assert.equal(cov!.distinctSources, 3);
  assert.equal(cov!.primarySources, 0, 'no source is ABOUT it');
  assert.ok(cov!.temporalSpreadDays >= 40, 'spread over months, not one sitting');
  await cognis.close();
});

test('uncoveredButRecurring surfaces the blind spot', async () => {
  const { cognis } = await corpusWithGap();
  const gaps = await cognis.uncoveredButRecurring({ minDistinctSources: 3 });

  const ids = gaps.map((g) => g.conceptId);
  assert.ok(
    ids.includes('wd:Q1049444'),
    `expected spaced repetition among gaps, got ${JSON.stringify(ids)}`,
  );

  const gap = gaps.find((g) => g.conceptId === 'wd:Q1049444')!;
  assert.equal(gap.primarySources, 0);
  assert.equal(gap.sourceIds.length, 3, 'must carry the evidence to tap through to');
  await cognis.close();
});

test('a concept covered directly is not reported as a gap', async () => {
  const { cognis } = await corpusWithGap();
  // Now actually read something about it.
  const doc = await ingest(
    cognis, 'https://example.com/deep',
    'Spaced repetition is a learning technique. Spaced repetition schedules ' +
      'reviews at expanding intervals, and spaced repetition is the subject here.',
    'Spaced repetition explained',
  );
  await cognis.linkDocument(doc.documentVersionId);
  await cognis.rollupCoverage();

  const gaps = await cognis.uncoveredButRecurring({ minDistinctSources: 3 });
  assert.ok(
    !gaps.some((g) => g.conceptId === 'wd:Q1049444'),
    'once covered directly it is no longer a gap',
  );
  await cognis.close();
});

test('coverage is recomputed wholesale and stays consistent with mentions', async () => {
  const { cognis } = await corpusWithGap();
  const first = await cognis.coverageFor('wd:Q1049444');

  await cognis.rollupCoverage();
  const second = await cognis.coverageFor('wd:Q1049444');

  assert.deepEqual(second, first, 'a rollup must be idempotent');
  await cognis.close();
});

test('the taxonomy tree comes from vocabulary hierarchy, and shows holes', async () => {
  const { cognis } = await corpusWithGap();
  await cognis.importHierarchy();

  const nodes = await cognis.taxonomy({ includeUncovered: true });
  const spacing = nodes.find((n) => n.conceptId === 'wd:Q1049444');
  assert.ok(spacing, 'expected spaced repetition in the tree');
  assert.equal(
    spacing!.parentId, 'wd:Q1148747',
    'the hierarchy comes free from external anchoring',
  );

  const parent = nodes.find((n) => n.conceptId === 'wd:Q1148747');
  assert.ok(parent, 'the parent concept must be present for the tree to render');
  await cognis.close();
});

test('deleting a source removes its mentions and the concept when unreferenced', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(
    cognis, 'https://example.com/only',
    'Sourdough fermentation relies on wild yeast. Sourdough rewards patience.',
    'Sourdough',
  );
  await cognis.linkDocument(doc.documentVersionId);
  await cognis.rollupCoverage();

  const sourceRow = await cognis.db.get<{ source_id: string }>(
    'SELECT source_id FROM document_version WHERE id = ?', [doc.documentVersionId],
  );
  await cognis.deleteSource(sourceRow!.source_id);

  const orphanMentions = await cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM mention WHERE chunk_id NOT IN (SELECT id FROM chunk)',
  );
  assert.equal(orphanMentions!.n, 0);

  await cognis.rollupCoverage();
  const cov = await cognis.coverageFor('wd:Q160402');
  assert.equal(cov, null, 'coverage must not survive its evidence');
  await cognis.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';
import { TemplateItemWriter } from '../src/adapters/template-item-writer.js';
import { Cognis } from '../src/core.js';

const SPACING = `Spaced repetition schedules reviews at expanding intervals, which
produces more durable retention than massed practice. Spaced repetition works
because each successful retrieval strengthens the memory trace. Spaced repetition
is most effective when intervals expand as material is learned.`;

const TESTING = `Retrieval practice strengthens memory more than rereading does.
The testing effect appears across domains and age groups. Retrieval practice is
effective even when the retrieval attempt fails, provided feedback follows.`;

async function corpusWithItems() {
  const { cognis, clock } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/spacing', SPACING,
    'Spaced repetition in practice');
  await ingestAndLink(cognis, 'https://example.com/testing', TESTING,
    'The testing effect');
  const report = await cognis.generateItems();
  return { cognis, clock, report };
}

test('items are generated with rubric points citing real spans', async () => {
  const { cognis, report } = await corpusWithItems();
  assert.ok(report.itemsGenerated > 0, 'expected items from a covered corpus');

  const items = await cognis.db.all<{ expected_points_json: string; evidence_json: string }>(
    'SELECT expected_points_json, evidence_json FROM quiz_item',
  );
  for (const item of items) {
    const points = JSON.parse(item.expected_points_json) as {
      citation: { documentVersionId: string; startChar: number; endChar: number };
    }[];
    assert.ok(points.length > 0, 'an item with no rubric cannot be graded');
    for (const p of points) {
      const doc = await cognis.db.get<{ text: string }>(
        'SELECT text FROM document_version WHERE id = ?',
        [p.citation.documentVersionId],
      );
      assert.ok(doc, 'citation must resolve to a real document');
      assert.ok(p.citation.endChar <= doc!.text.length);
      assert.ok(doc!.text.slice(p.citation.startChar, p.citation.endChar).trim());
    }
  }
  await cognis.close();
});

test('an item whose citations do not resolve is rejected, not stored', async () => {
  const { cognis } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/spacing', SPACING, 'Spacing');

  const broken = new Cognis({
    db: cognis.db, clock: cognis.clock,
    embedder: cognis.embedder!, vocabulary: cognis.vocabulary!, linker: cognis.linker!,
    itemWriter: new TemplateItemWriter({ emitBrokenCitations: true }),
    grader: cognis.grader!,
  });

  const report = await broken.generateItems();
  assert.equal(report.itemsGenerated, 0, 'ungrounded items must never reach the user');
  assert.ok(report.itemsRejected > 0);
  assert.ok(
    report.rejections.some((r) => /out of bounds/.test(r.reason)),
    `expected an out-of-bounds rejection, got ${JSON.stringify(report.rejections)}`,
  );

  const stored = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM quiz_item');
  assert.equal(stored!.n, 0);
  await cognis.close();
});

test('a review stores the raw answer verbatim and advances the schedule', async () => {
  const { cognis, clock } = await corpusWithItems();
  const [card] = await cognis.dueItems({ limit: 1 });
  assert.ok(card, 'expected a due item');

  const presentedAt = clock.now();
  clock.advanceMs(45_000);
  const answer = 'Spaced repetition expands intervals and produces durable retention.';

  const result = await cognis.submitReview({
    quizItemId: card!.quizItemId,
    answerText: answer,
    presentedAt,
    answeredAt: clock.now(),
    predictedRecall: card!.predictedRecall,
  });

  const review = await cognis.db.get<{
    answer_text: string; machine_grade: number; machine_rating: number;
    grade_model_id: string; grade_rubric_version: string; latency_ms: number;
  }>('SELECT * FROM review WHERE id = ?', [result.reviewId]);

  assert.equal(review!.answer_text, answer, 'the answer is evidence and is stored as given');
  assert.equal(review!.grade_model_id, 'keyword-grader-v1');
  assert.ok(review!.grade_rubric_version);
  assert.equal(review!.latency_ms, 45_000);
  assert.ok(Date.parse(result.nextDueAt) > Date.parse(clock.now()));
  await cognis.close();
});

test('a wrong answer schedules sooner than a right one', async () => {
  const { cognis, clock } = await corpusWithItems();
  const cards = await cognis.dueItems({ limit: 2 });
  assert.ok(cards.length >= 2, 'need two items to compare');

  const good = await cognis.submitReview({
    quizItemId: cards[0]!.quizItemId,
    answerText:
      'Spaced repetition schedules reviews at expanding intervals which produces ' +
      'more durable retention than massed practice, because each successful ' +
      'retrieval strengthens the memory trace.',
    presentedAt: clock.now(), answeredAt: clock.now(),
  });
  const bad = await cognis.submitReview({
    quizItemId: cards[1]!.quizItemId,
    answerText: 'no idea',
    presentedAt: clock.now(), answeredAt: clock.now(),
  });

  assert.ok(good.rating > bad.rating, 'a better answer must earn a better rating');
  assert.ok(
    Date.parse(good.nextDueAt) > Date.parse(bad.nextDueAt),
    'a failed item must come back sooner',
  );
  await cognis.close();
});

test('sessions respect the budget and interleave concepts', async () => {
  const { cognis } = await corpusWithItems();
  const cards = await cognis.dueItems({ limit: 3 });

  assert.ok(cards.length <= 3, 'the budget is a hard cap');
  if (cards.length >= 2) {
    // Interleaving: consecutive cards should not all be the same concept when
    // more than one concept has items due.
    const concepts = new Set(cards.map((c) => c.conceptId));
    const available = await cognis.db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT concept_id) AS n FROM quiz_item WHERE retired_at IS NULL',
    );
    if (available!.n > 1) {
      assert.ok(concepts.size > 1, 'a session must mix concepts, not block on one');
    }
  }
  await cognis.close();
});

test('a user override changes the rating and the schedule', async () => {
  const { cognis, clock } = await corpusWithItems();
  const [card] = await cognis.dueItems({ limit: 1 });

  const result = await cognis.submitReview({
    quizItemId: card!.quizItemId,
    answerText: 'no idea',
    presentedAt: clock.now(), answeredAt: clock.now(),
  });
  assert.equal(result.rating, 1);

  const overridden = await cognis.overrideGrade(result.reviewId, 4);
  const row = await cognis.db.get<{ user_grade_override: number }>(
    'SELECT user_grade_override FROM review WHERE id = ?', [result.reviewId],
  );
  assert.equal(row!.user_grade_override, 4, 'disagreement is recorded, not discarded');
  assert.ok(
    Date.parse(overridden.nextDueAt) > Date.parse(result.nextDueAt),
    'the user judgment is the better one and must move the schedule',
  );
  await cognis.close();
});

test('synthesis items need two sources and are skipped below that', async () => {
  const { cognis } = await freshCognis();
  // One source only: a synthesis question about how sources differ cannot
  // honestly be asked, so the writer declines rather than inventing one.
  await ingestAndLink(cognis, 'https://example.com/spacing', SPACING, 'Spacing');
  await cognis.generateItems({ kinds: ['synthesis'] });

  const single = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM quiz_item WHERE kind = 'synthesis'`,
  );
  assert.equal(single!.n, 0, 'one source cannot support a cross-source question');

  // A second source covering the same concept makes it possible.
  await ingestAndLink(
    cognis, 'https://example.com/spacing-2',
    `Spaced repetition is sometimes criticised. Spaced repetition schedules can
     feel mechanical, and spaced repetition may suit facts more than reasoning.`,
    'A critique of spaced repetition',
  );
  await cognis.generateItems({ kinds: ['synthesis'] });

  const rows = await cognis.db.all<{ evidence_json: string }>(
    `SELECT evidence_json FROM quiz_item WHERE kind = 'synthesis'`,
  );
  assert.ok(rows.length > 0, 'two sources on one concept must enable synthesis');

  const evidence = JSON.parse(rows[0]!.evidence_json) as { sourceId: string }[];
  assert.ok(
    new Set(evidence.map((e) => e.sourceId)).size >= 2,
    'a synthesis item must cite more than one source, or it is not synthesis',
  );
  await cognis.close();
});

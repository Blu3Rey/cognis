/**
 * The M3 completion criterion (docs/11-roadmap.md):
 *
 *   "the user has answered 100 items across >=6 weeks and the calibration
 *    report is populated — the first moment any retention claim is defensible."
 *
 * Simulated, obviously: real completion needs a real user answering real
 * questions over real weeks. What this asserts is that the machinery supports
 * it — that 100 graded reviews over six simulated weeks produce a schedule
 * that holds together and a calibration report with enough data to read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';

const CORPUS: [string, string, string][] = [
  ['https://example.com/spacing',
   `Spaced repetition schedules reviews at expanding intervals, producing more
    durable retention than massed practice. Spaced repetition strengthens the
    memory trace with each successful retrieval. Spaced repetition is most
    effective when intervals expand as the material is learned.`,
   'Spaced repetition in practice'],
  ['https://example.com/testing',
   `Retrieval practice strengthens memory more than rereading. The testing
    effect appears across domains and age groups. Retrieval practice remains
    effective even when the attempt fails, provided feedback follows promptly.`,
   'The testing effect'],
  ['https://example.com/interleaving',
   `Interleaving mixes topics within a single study session. Interleaving
    lowers performance during practice and raises retention on delayed tests.
    Interleaving feels harder than blocking, which is part of why it works.`,
   'Why interleaving works'],
];

const GOOD =
  'Reviews at expanding intervals produce durable retention because each ' +
  'successful retrieval strengthens the memory trace, and practice distributed ' +
  'over time beats massed practice.';

test('100 reviews across six weeks yield a readable calibration report', async () => {
  const { cognis, clock } = await freshCognis();
  const startedAt = clock.now();

  for (const [url, text, title] of CORPUS) {
    await ingestAndLink(cognis, url, text, title);
  }
  const generated = await cognis.generateItems();
  assert.ok(generated.itemsGenerated > 0, 'the corpus must yield items');

  let answered = 0;
  let days = 0;
  // Six weeks of daily sessions under a realistic daily budget.
  while (days < 42) {
    const due = await cognis.dueItems({ limit: 8 });
    for (const [i, card] of due.entries()) {
      const presentedAt = clock.now();
      clock.advanceMs(25_000);
      await cognis.submitReview({
        quizItemId: card.quizItemId,
        // A mix of outcomes, otherwise calibration has only one bin and says
        // nothing about reliability.
        answerText: (answered + i) % 4 === 0 ? 'not sure' : GOOD,
        presentedAt,
        answeredAt: clock.now(),
        predictedRecall: card.predictedRecall,
        intervalDays: card.intervalDays,
      });
      answered++;
    }
    clock.advanceDays(1);
    days++;
  }

  const elapsedDays =
    (Date.parse(clock.now()) - Date.parse(startedAt)) / 86_400_000;
  assert.ok(elapsedDays >= 42, `expected >=6 weeks, got ${elapsedDays.toFixed(1)} days`);
  assert.ok(answered >= 100, `expected >=100 reviews, got ${answered}`);

  const report = await cognis.calibration();
  assert.ok(report.bins.length >= 2, 'a single bin cannot show calibration');
  assert.ok(report.brier > 0 && report.brier < 1, `implausible Brier ${report.brier}`);

  // Reviews split cleanly: a first exposure has no prior state, so the
  // scheduler makes no claim and the review is excluded — but the count is
  // disclosed rather than dropped silently.
  assert.equal(
    report.reviewsWithPredictions + report.reviewsWithoutPredictions, answered,
    'every review must be either measured or declared excluded',
  );
  assert.ok(
    report.reviewsWithPredictions >= 50,
    `too few measurable reviews: ${report.reviewsWithPredictions} of ${answered}`,
  );

  // The only reviews lacking a prediction are first exposures of an item.
  const unpredicted = await cognis.db.all<{ quiz_item_id: string; presented_at: string }>(
    'SELECT quiz_item_id, presented_at FROM review WHERE predicted_recall IS NULL',
  );
  for (const r of unpredicted) {
    const earlier = await cognis.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM review
        WHERE quiz_item_id = ? AND presented_at < ?`,
      [r.quiz_item_id, r.presented_at],
    );
    assert.equal(
      earlier!.n, 0,
      'only a first exposure may lack a prediction; a repeat review must carry one',
    );
  }

  // And the retention claims that follow are now defensible for at least one
  // concept, with the evidence attached.
  const evidenced = await cognis.db.all<{ concept_id: string }>(
    'SELECT DISTINCT concept_id FROM review',
  );
  let sufficient = 0;
  for (const c of evidenced) {
    const ev = await cognis.retentionEvidence(c.concept_id);
    if (ev.evidenceSufficient) {
      assert.notEqual(ev.modelledRecall, null);
      assert.ok(ev.recentOutcomes.length > 0, 'a score never travels alone');
      sufficient++;
    }
  }
  assert.ok(sufficient > 0, 'six weeks of reviewing must make some claim defensible');

  await cognis.close();
});

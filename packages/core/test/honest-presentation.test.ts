/**
 * The rules from docs/05 § Honest presentation, as tests.
 *
 * A green "87% retained" badge manufactures the illusion of competence the
 * underlying science warns about, so these constraints live in the types and
 * are asserted here rather than left to a UI style guide.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';
import {
  MIN_REVIEWS_FOR_ESTIMATE, DURABILITY_INTERVAL_DAYS,
} from '../src/retention/evidence.js';

const SPACING = `Spaced repetition schedules reviews at expanding intervals, which
produces more durable retention than massed practice. Spaced repetition works
because each successful retrieval strengthens the memory trace.`;

const GOOD_ANSWER =
  'Spaced repetition schedules reviews at expanding intervals which produces ' +
  'more durable retention than massed practice, because each successful ' +
  'retrieval strengthens the memory trace.';

async function corpus() {
  const { cognis, clock } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/spacing', SPACING, 'Spacing');
  await cognis.generateItems();
  return { cognis, clock };
}

test('with no reviews, there is no score to render and a question instead', async () => {
  const { cognis } = await corpus();
  const ev = await cognis.retentionEvidence('wd:Q1049444');

  assert.equal(ev.reviewCount, 0);
  assert.equal(ev.evidenceSufficient, false);
  assert.equal(ev.modelledRecall, null, 'nothing for a client to render a score from');
  assert.equal(ev.durablyKnown, false);
  assert.ok(ev.questionInstead, 'the honest display is a question, not a number');
  await cognis.close();
});

test('one review is still not enough evidence for an estimate', async () => {
  const { cognis, clock } = await corpus();
  const [card] = await cognis.dueItems({ limit: 1 });
  await cognis.submitReview({
    quizItemId: card!.quizItemId, answerText: GOOD_ANSWER,
    presentedAt: clock.now(), answeredAt: clock.now(),
  });

  const ev = await cognis.retentionEvidence('wd:Q1049444');
  assert.equal(ev.reviewCount, 1);
  assert.ok(MIN_REVIEWS_FOR_ESTIMATE > 1);
  assert.equal(ev.evidenceSufficient, false);
  assert.equal(ev.modelledRecall, null);
  await cognis.close();
});

test('repeated short-interval successes do not earn "durably known"', async () => {
  const { cognis, clock } = await corpus();

  // Four passes in four days. Classic cramming: feels like mastery, shows
  // nothing about durability.
  for (let i = 0; i < 4; i++) {
    const due = await cognis.dueItems({ limit: 1 });
    if (due.length === 0) break;
    const presentedAt = clock.now();
    clock.advanceMs(30_000);
    await cognis.submitReview({
      quizItemId: due[0]!.quizItemId, answerText: GOOD_ANSWER,
      presentedAt, answeredAt: clock.now(),
      predictedRecall: due[0]!.predictedRecall,
      intervalDays: due[0]!.intervalDays,
    });
    clock.advanceDays(1);
  }

  const ev = await cognis.retentionEvidence('wd:Q1049444');
  assert.ok(ev.reviewCount >= 2, 'fixture must produce several reviews');
  assert.equal(
    ev.durablyKnown, false,
    `short-interval successes must not read as mastery ` +
      `(longest interval ${ev.longestSuccessfulIntervalDays}d, ` +
      `threshold ${DURABILITY_INTERVAL_DAYS}d)`,
  );
  await cognis.close();
});

test('a success at a long interval does earn it', async () => {
  const { cognis, clock } = await corpus();

  const first = await cognis.dueItems({ limit: 1 });
  await cognis.submitReview({
    quizItemId: first[0]!.quizItemId, answerText: GOOD_ANSWER,
    presentedAt: clock.now(), answeredAt: clock.now(),
  });

  clock.advanceDays(DURABILITY_INTERVAL_DAYS + 5);
  const later = await cognis.dueItems({ limit: 1 });
  assert.ok(later.length > 0, 'the item should be due again after a long gap');
  assert.ok(
    (later[0]!.intervalDays ?? 0) >= DURABILITY_INTERVAL_DAYS,
    'the gap must be recorded as the interval',
  );

  await cognis.submitReview({
    quizItemId: later[0]!.quizItemId, answerText: GOOD_ANSWER,
    presentedAt: clock.now(), answeredAt: clock.now(),
    predictedRecall: later[0]!.predictedRecall,
    intervalDays: later[0]!.intervalDays,
  });

  const ev = await cognis.retentionEvidence('wd:Q1049444');
  assert.equal(ev.evidenceSufficient, true);
  assert.notEqual(ev.modelledRecall, null, 'now there is a defensible estimate');
  assert.equal(ev.durablyKnown, true);
  await cognis.close();
});

test('evidence always carries what the estimate rests on', async () => {
  const { cognis, clock } = await corpus();
  for (let i = 0; i < 2; i++) {
    const due = await cognis.dueItems({ limit: 1 });
    if (due.length === 0) break;
    await cognis.submitReview({
      quizItemId: due[0]!.quizItemId, answerText: GOOD_ANSWER,
      presentedAt: clock.now(), answeredAt: clock.now(),
      predictedRecall: due[0]!.predictedRecall,
      intervalDays: due[0]!.intervalDays,
    });
    clock.advanceDays(3);
  }

  const ev = await cognis.retentionEvidence('wd:Q1049444');
  // A number is never returned alone: the client can always show when the last
  // successful recall was and at what interval.
  assert.ok(ev.recentOutcomes.length > 0);
  assert.ok(ev.lastSuccessfulRecallAt);
  for (const o of ev.recentOutcomes) {
    assert.ok(o.at);
    assert.ok(o.rating >= 1 && o.rating <= 4);
  }
  await cognis.close();
});

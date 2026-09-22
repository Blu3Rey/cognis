/**
 * The M5 completion criterion (docs/11-roadmap.md):
 *
 *   "telemetry-derived engagement measurably improves scheduler calibration
 *    versus the default-only baseline. If it does not, that is a real and
 *    publishable finding about the whole premise, and the reader's scope
 *    should shrink."
 *
 * These tests deliberately do NOT assert that the engagement prior improves
 * calibration.
 *
 * On simulated data, whether it "improves" anything is decided entirely by how
 * the simulation generates outcomes. If the fixture made deeply-engaged
 * concepts easier to recall, the harness would report an improvement, the test
 * would pass, and the number would mean nothing except that I wrote the
 * fixture to produce it. That is the circular result the whole evaluation
 * discipline in docs/12 exists to prevent.
 *
 * What is asserted instead: the harness computes an honest counterfactual, it
 * refuses to claim significance on thin data, and it reports zero difference
 * when there is no telemetry for the prior to act on. The real finding needs
 * real reading sessions and real reviews.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';
import {
  formatEngagementComparison, MIN_REVIEWS_FOR_COMPARISON,
} from '../src/eval/engagement.js';
import {
  DEFAULT_ENGAGEMENT_PRIOR, NEUTRAL_ENGAGEMENT_PRIOR,
} from '../src/reader/engagement-prior.js';

/**
 * Long enough that a realistic reading session passes the plausibility guard.
 * A short fixture would be rejected as "active time exceeds the expected
 * reading time", and the telemetry arm of this test would silently measure
 * nothing — which is precisely what happened on the first attempt.
 */
function article(topic: string, body: string): string {
  return Array.from({ length: 12 }, (_, i) =>
    `${body} This is paragraph ${i + 1} on ${topic}, restating the point at ` +
    `length so the document has a realistic word count for a reading session.`,
  ).join('\n\n');
}

const TEXTS: [string, string, string][] = [
  ['https://example.com/spacing',
   article('spacing',
     `Spaced repetition schedules reviews at expanding intervals producing durable
      retention. Spaced repetition strengthens the memory trace on each retrieval.`),
   'Spacing'],
  ['https://example.com/testing',
   article('the testing effect',
     `Retrieval practice strengthens memory more than rereading. The testing effect
      appears across domains. Retrieval practice works even when attempts fail.`),
   'Testing effect'],
  ['https://example.com/interleaving',
   article('interleaving',
     `Interleaving mixes topics within a session. Interleaving lowers practice
      performance and raises delayed retention. Interleaving feels harder.`),
   'Interleaving'],
];

const GOOD =
  'Reviews at expanding intervals produce durable retention because each ' +
  'successful retrieval strengthens the memory trace.';

async function reviewedCorpus(withTelemetry: boolean) {
  const { cognis, clock } = await freshCognis();

  for (const [url, text, title] of TEXTS) {
    const doc = await ingestAndLink(cognis, url, text, title);
    if (withTelemetry) {
      const words = await cognis.db.get<{ word_count: number }>(
        'SELECT word_count FROM document_version WHERE id = ?',
        [doc.documentVersionId],
      );
      // A session paced at a plausible reading rate for this document, so the
      // guard accepts it and the prior actually has something to act on.
      const activeMs = Math.round((words!.word_count / 240) * 60_000 * 0.9);
      const started = clock.now();
      clock.advanceMs(activeMs + 5_000);
      const rec = await cognis.recordTelemetry({
        ingestionEventId: doc.ingestionEventId,
        startedAt: started,
        endedAt: clock.now(),
        activeMs,
        maxScrollPct: 0.95,
        scrollReversals: 3,
      });
      assert.equal(
        rec.verdict.plausible, true,
        `fixture telemetry must be plausible or this test measures nothing: ` +
          `${rec.verdict.reason}`,
      );
      assert.equal(rec.derivedEngagement, 'read');
    }
    clock.advanceDays(2);
  }
  await cognis.generateItems();

  let answered = 0;
  for (let day = 0; day < 42; day++) {
    const due = await cognis.dueItems({ limit: 6 });
    for (const [i, card] of due.entries()) {
      const presentedAt = clock.now();
      clock.advanceMs(20_000);
      await cognis.submitReview({
        quizItemId: card.quizItemId,
        answerText: (answered + i) % 4 === 0 ? 'not sure' : GOOD,
        presentedAt,
        answeredAt: clock.now(),
        predictedRecall: card.predictedRecall,
        intervalDays: card.intervalDays,
      });
      answered++;
    }
    clock.advanceDays(1);
  }
  return { cognis, answered };
}

test('the harness computes an honest counterfactual over the real review log', async () => {
  const { cognis, answered } = await reviewedCorpus(true);
  const result = await cognis.evaluateEngagementPrior();

  assert.ok(answered > 50, `fixture must produce reviews, got ${answered}`);
  // Without this the telemetry arm can pass while exercising nothing.
  assert.ok(
    result.telemetryBackedReviews > 0,
    'the fixture must produce telemetry-backed reviews for the comparison to mean anything',
  );
  assert.equal(
    result.withPrior.scored, result.withoutPrior.scored,
    'both runs must score the same reviews, or the comparison is meaningless',
  );
  assert.ok(result.withPrior.scored > 0);
  assert.ok(result.withPrior.brier >= 0 && result.withPrior.brier <= 1);
  assert.ok(result.withoutPrior.brier >= 0 && result.withoutPrior.brier <= 1);
  assert.equal(
    result.brierDelta,
    result.withPrior.brier - result.withoutPrior.brier,
  );

  // NOT asserted: that brierDelta < 0. On simulated data that would only
  // confirm how the fixture was written.
  assert.ok(formatEngagementComparison(result).includes('delta'));
  await cognis.close();
});

test('with no telemetry the two runs are identical, and the harness says why', async () => {
  const { cognis } = await reviewedCorpus(false);
  const result = await cognis.evaluateEngagementPrior();

  assert.equal(result.telemetryBackedReviews, 0);
  assert.equal(
    result.sufficientData, false,
    'no telemetry means nothing for the prior to act on',
  );
  assert.ok(
    result.notes.some((n) => /no reviews are backed by plausible telemetry/.test(n)),
    `expected an explanatory note, got ${JSON.stringify(result.notes)}`,
  );
  await cognis.close();
});

test('a thin review log is reported as insufficient rather than as a result', async () => {
  const { cognis, clock } = await freshCognis();
  const doc = await ingestAndLink(cognis, TEXTS[0]![0], TEXTS[0]![1], TEXTS[0]![2]);
  await cognis.recordTelemetry({
    ingestionEventId: doc.ingestionEventId,
    startedAt: clock.now(),
    endedAt: new Date(Date.parse(clock.now()) + 40_000).toISOString(),
    activeMs: 35_000, maxScrollPct: 0.95, scrollReversals: 3,
  });
  await cognis.generateItems();

  const due = await cognis.dueItems({ limit: 2 });
  for (const card of due) {
    await cognis.submitReview({
      quizItemId: card.quizItemId, answerText: GOOD,
      presentedAt: clock.now(), answeredAt: clock.now(),
    });
  }

  const result = await cognis.evaluateEngagementPrior();
  assert.ok(result.withPrior.scored < MIN_REVIEWS_FOR_COMPARISON);
  assert.equal(
    result.sufficientData, false,
    'a delta over a handful of reviews is noise, and must not read as a finding',
  );
  assert.ok(result.notes.some((n) => /minimum for the delta/.test(n)));
  assert.ok(
    formatEngagementComparison(result).includes('NO — do not act on this'),
    'the formatted report must refuse to be quoted as a result',
  );
  await cognis.close();
});

test('the neutral prior is a true no-op, so the baseline is a real baseline', async () => {
  const { cognis } = await reviewedCorpus(true);

  const neutral = await cognis.evaluateEngagementPrior({
    prior: NEUTRAL_ENGAGEMENT_PRIOR,
  });
  assert.equal(
    neutral.brierDelta, 0,
    'comparing the neutral prior against itself must show exactly no difference',
  );

  // And the default prior is genuinely different from neutral, otherwise the
  // whole comparison would be measuring nothing.
  const values = Object.values(DEFAULT_ENGAGEMENT_PRIOR.multipliers);
  assert.ok(values.some((v) => v !== 1), 'the hypothesis must be non-trivial');
  await cognis.close();
});

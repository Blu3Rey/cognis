/**
 * Calibration is the gate for the whole retention feature (docs/12 §5). A
 * well-calibrated model that is modestly accurate is useful and honest; a
 * confident, badly-calibrated one is the failure mode the design exists to
 * avoid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';

const TEXTS: [string, string, string][] = [
  ['https://example.com/spacing',
   `Spaced repetition schedules reviews at expanding intervals producing durable
    retention. Spaced repetition strengthens the memory trace on each retrieval.`,
   'Spacing'],
  ['https://example.com/testing',
   `Retrieval practice strengthens memory more than rereading. The testing effect
    appears across domains and ages. Retrieval practice works even when it fails.`,
   'Testing effect'],
  ['https://example.com/interleaving',
   `Interleaving mixes topics within a session. Interleaving lowers practice
    performance and raises delayed retention. Interleaving feels harder.`,
   'Interleaving'],
];

test('calibration is empty but valid before any predictions exist', async () => {
  const { cognis } = await freshCognis();
  const report = await cognis.calibration();

  assert.equal(report.reviewsWithPredictions, 0);
  assert.deepEqual(report.bins, []);
  assert.equal(report.brier, 0);
  assert.ok(report.asOf, 'an empty report is still a report');
  await cognis.close();
});

test('a populated calibration report records predictions against outcomes', async () => {
  const { cognis, clock } = await freshCognis();
  for (const [url, text, title] of TEXTS) {
    await ingestAndLink(cognis, url, text, title);
  }
  await cognis.generateItems();

  // Six weeks of reviewing, alternating good and poor answers so the report
  // has both successes and failures to bin.
  for (let week = 0; week < 6; week++) {
    for (let day = 0; day < 7; day++) {
      const due = await cognis.dueItems({ limit: 5 });
      for (const [i, card] of due.entries()) {
        const presentedAt = clock.now();
        clock.advanceMs(20_000);
        await cognis.submitReview({
          quizItemId: card.quizItemId,
          answerText: (week + i) % 3 === 0
            ? 'no idea'
            : 'Spaced repetition expands intervals producing durable retention ' +
              'because each successful retrieval strengthens the memory trace.',
          presentedAt,
          answeredAt: clock.now(),
          predictedRecall: card.predictedRecall,
          intervalDays: card.intervalDays,
        });
      }
      clock.advanceDays(1);
    }
  }

  const report = await cognis.calibration();
  assert.ok(
    report.reviewsWithPredictions > 0,
    'predictions must be captured at presentation time or calibration is impossible',
  );
  assert.ok(report.bins.length > 0);
  for (const bin of report.bins) {
    assert.ok(bin.n > 0);
    assert.ok(bin.predicted >= 0 && bin.predicted <= 1);
    assert.ok(bin.observed >= 0 && bin.observed <= 1);
  }
  assert.ok(report.brier >= 0 && report.brier <= 1);
  await cognis.close();
});

test('memory state is rebuildable from the review log alone', async () => {
  const { cognis, clock } = await freshCognis();
  await ingestAndLink(cognis, TEXTS[0]![0], TEXTS[0]![1], TEXTS[0]![2]);
  await cognis.generateItems();

  for (let i = 0; i < 5; i++) {
    const due = await cognis.dueItems({ limit: 2 });
    for (const card of due) {
      await cognis.submitReview({
        quizItemId: card.quizItemId,
        answerText: 'Spaced repetition expands intervals producing durable retention.',
        presentedAt: clock.now(), answeredAt: clock.now(),
        predictedRecall: card.predictedRecall,
      });
    }
    clock.advanceDays(2);
  }

  const before = await cognis.db.all<{ scope_id: string; due_at: string; reps: number }>(
    `SELECT scope_id, due_at, reps FROM memory_state WHERE scope = 'item' ORDER BY scope_id`,
  );
  assert.ok(before.length > 0);

  // This is why memory state is derived: a scheduler upgrade or a parameter
  // refit is a recompute, not a migration.
  await cognis.db.run(`DELETE FROM memory_state`);
  const rebuilt = await cognis.rebuildMemoryStates();
  assert.ok(rebuilt.reviewsReplayed > 0);

  const after = await cognis.db.all<{ scope_id: string; due_at: string; reps: number }>(
    `SELECT scope_id, due_at, reps FROM memory_state WHERE scope = 'item' ORDER BY scope_id`,
  );
  assert.deepEqual(after, before, 'a replay must reproduce the same schedule');
  await cognis.close();
});

test('the scheduler records its version and parameter hash', async () => {
  const { cognis, clock } = await freshCognis();
  await ingestAndLink(cognis, TEXTS[0]![0], TEXTS[0]![1], TEXTS[0]![2]);
  await cognis.generateItems();

  const [card] = await cognis.dueItems({ limit: 1 });
  await cognis.submitReview({
    quizItemId: card!.quizItemId, answerText: 'retention',
    presentedAt: clock.now(), answeredAt: clock.now(),
  });

  const state = await cognis.db.get<{
    scheduler: string; scheduler_version: string; params_hash: string;
  }>(`SELECT scheduler, scheduler_version, params_hash FROM memory_state LIMIT 1`);

  assert.equal(state!.scheduler, 'ts-fsrs');
  assert.ok(state!.scheduler_version, 'a refit must be auditable');
  assert.ok(state!.params_hash);
  await cognis.close();
});

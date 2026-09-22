import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';
import {
  assessPlausibility, deriveEngagement, READING_WPM, MAX_TIME_MULTIPLE,
} from '../src/reader/telemetry.js';
import type { RawTelemetry } from '../src/reader/telemetry.js';

const WORDS = 600;
const EXPECTED_MS = Math.round((WORDS / READING_WPM) * 60_000);

function session(over: Partial<RawTelemetry> = {}): RawTelemetry {
  return {
    ingestionEventId: 'ie',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:03:00.000Z',
    activeMs: EXPECTED_MS,
    maxScrollPct: 0.95,
    scrollReversals: 2,
    ...over,
  };
}

test('a phone left open on an article is rejected', async () => {
  // Twenty minutes of "reading" a two-and-a-half minute article.
  const verdict = assessPlausibility(
    session({ activeMs: 20 * 60_000, endedAt: '2026-01-01T00:20:00.000Z' }),
    WORDS,
  );
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason!, /exceeds/);
  assert.equal(
    verdict.cappedActiveMs, EXPECTED_MS * MAX_TIME_MULTIPLE,
    'the cap still bounds the recorded value',
  );
});

test('a page open with no scroll events is rejected', () => {
  const verdict = assessPlausibility(
    session({ maxScrollPct: 0, scrollReversals: 0 }), WORDS,
  );
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason!, /no scroll events/);
});

test('active time exceeding wall-clock is rejected', () => {
  const verdict = assessPlausibility(
    session({
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:30.000Z',
      activeMs: 120_000,
    }),
    WORDS,
  );
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason!, /wall-clock/);
});

test('a momentary open is not a reading session', () => {
  const verdict = assessPlausibility(session({ activeMs: 1_200 }), WORDS);
  assert.equal(verdict.plausible, false);
  assert.match(verdict.reason!, /too short/);
});

test('a genuine read is accepted and derives "read"', () => {
  const t = session();
  const verdict = assessPlausibility(t, WORDS);
  assert.equal(verdict.plausible, true);
  assert.equal(verdict.reason, null);
  assert.equal(deriveEngagement(verdict, t), 'read');
});

test('a quick partial scroll derives "skim", not "read"', () => {
  const t = session({ activeMs: 20_000, maxScrollPct: 0.3 });
  const verdict = assessPlausibility(t, WORDS);
  assert.equal(verdict.plausible, true);
  assert.equal(deriveEngagement(verdict, t), 'skim');
});

test('telemetry never derives apply or teach', () => {
  // No amount of scrolling establishes that the user used or taught something.
  for (const scroll of [0.5, 0.9, 1.0]) {
    for (const ms of [10_000, EXPECTED_MS, EXPECTED_MS * 2]) {
      const t = session({ activeMs: ms, maxScrollPct: scroll });
      const derived = deriveEngagement(assessPlausibility(t, WORDS), t);
      assert.ok(
        derived === null || derived === 'skim' || derived === 'read',
        `telemetry produced ${derived}, which only the user can assert`,
      );
    }
  }
});

test('an implausible session is recorded, not discarded', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingestAndLink(cognis, 'https://example.com/a',
    'Spaced repetition improves retention over time.', 'Spacing');

  const res = await cognis.recordTelemetry({
    ingestionEventId: doc.ingestionEventId,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T02:00:00.000Z',
    activeMs: 2 * 60 * 60_000,
    maxScrollPct: 0.1,
    scrollReversals: 0,
  });

  assert.equal(res.verdict.plausible, false);
  assert.equal(res.derivedEngagement, null);
  assert.equal(res.engagementApplied, false);

  // "Did not happen" and "happened but is not trustworthy" are different facts.
  const row = await cognis.db.get<{ plausible: number; implausible_reason: string }>(
    'SELECT plausible, implausible_reason FROM reading_session WHERE id = ?',
    [res.readingSessionId],
  );
  assert.equal(row!.plausible, 0);
  assert.ok(row!.implausible_reason);

  const event = await cognis.db.get<{ engagement: string | null }>(
    'SELECT engagement FROM ingestion_event WHERE id = ?', [doc.ingestionEventId],
  );
  assert.equal(event!.engagement, null, 'an untrustworthy session must not set engagement');
  await cognis.close();
});

test('a plausible session raises engagement but never lowers it', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingestAndLink(cognis, 'https://example.com/a',
    'Spaced repetition improves retention. '.repeat(40), 'Spacing');

  await cognis.recordEngagement(doc.ingestionEventId, 'annotate', 'user_asserted');

  const res = await cognis.recordTelemetry({
    ingestionEventId: doc.ingestionEventId,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:20.000Z',
    activeMs: 15_000,
    maxScrollPct: 0.2,
    scrollReversals: 1,
  });

  assert.equal(res.derivedEngagement, 'skim');
  assert.equal(res.engagementApplied, false, 'a later skim must not erase an annotation');

  const event = await cognis.db.get<{ engagement: string }>(
    'SELECT engagement FROM ingestion_event WHERE id = ?', [doc.ingestionEventId],
  );
  assert.equal(event!.engagement, 'annotate');
  await cognis.close();
});

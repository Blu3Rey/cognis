/**
 * Honest presentation.
 *
 * docs/05 § Honest presentation: a retention figure shown as a verdict
 * manufactures the illusion of competence the underlying science warns about.
 * A green "87% retained" badge is worse than showing nothing, because it
 * licenses the user to stop.
 *
 * The rules are enforced here rather than in a style guide: when the evidence
 * is insufficient, `modelledRecall` is null and there is simply nothing for a
 * client to render a score from.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import { Scheduler, loadMemoryState } from './scheduler.js';

const DAY_MS = 86_400_000;

/** Minimum graded retrievals before a modelled figure is offered at all. */
export const MIN_REVIEWS_FOR_ESTIMATE = 2;

/**
 * Interval at which a success actually demonstrates durability. Repeated
 * short-interval successes demonstrate nothing, so "mastered" is withheld
 * until a recall survives a real gap.
 */
export const DURABILITY_INTERVAL_DAYS = 21;

export interface RetentionEvidence {
  conceptId: string;
  reviewCount: number;
  lastSuccessfulRecallAt: string | null;
  longestSuccessfulIntervalDays: number | null;
  recentOutcomes: { at: string; rating: number; intervalDays: number | null }[];
  /** Null whenever `evidenceSufficient` is false. */
  modelledRecall: number | null;
  /** False ⇒ the client MUST NOT render a score. */
  evidenceSufficient: boolean;
  /**
   * True only after a successful recall at a durable interval. This is the
   * gate on any "you know this" presentation.
   */
  durablyKnown: boolean;
  /** What to ask when the evidence is too thin to report. */
  questionInstead: string | null;
}

const PASSING_RATING = 3; // Good or Easy

export async function retentionEvidence(
  db: SqlDriver,
  clock: Clock,
  scheduler: Scheduler,
  conceptId: string,
): Promise<RetentionEvidence> {
  const reviews = await db.all<{
    id: string; quiz_item_id: string | null; presented_at: string;
    machine_rating: number | null; user_grade_override: number | null;
    self_rating: number | null; interval_days: number | null;
  }>(
    `SELECT id, quiz_item_id, presented_at, machine_rating, user_grade_override,
            self_rating, interval_days
       FROM review
      WHERE concept_id = ?
      ORDER BY presented_at DESC`,
    [conceptId],
  );

  const outcomes = reviews
    .map((r) => ({
      at: r.presented_at,
      rating: (r.user_grade_override ?? r.machine_rating ?? r.self_rating ?? 0) as number,
      intervalDays: r.interval_days,
    }))
    .filter((o) => o.rating > 0);

  const successes = outcomes.filter((o) => o.rating >= PASSING_RATING);
  const lastSuccess = successes[0]?.at ?? null;

  let longest: number | null = null;
  for (const s of successes) {
    if (s.intervalDays !== null && (longest === null || s.intervalDays > longest)) {
      longest = s.intervalDays;
    }
  }

  const evidenceSufficient = outcomes.length >= MIN_REVIEWS_FOR_ESTIMATE;

  let modelledRecall: number | null = null;
  if (evidenceSufficient) {
    // Aggregate over this concept's items. Presented as a summary of evidence,
    // never as an independently modelled concept-level quantity (ADR-0006).
    const itemIds = await db.all<{ id: string }>(
      'SELECT id FROM quiz_item WHERE concept_id = ? AND retired_at IS NULL',
      [conceptId],
    );
    const now = new Date(clock.now());
    const values: number[] = [];
    for (const it of itemIds) {
      const state = await loadMemoryState(db, 'item', it.id);
      if (state) values.push(scheduler.retrievability(state.card, now));
    }
    if (values.length > 0) {
      modelledRecall = values.reduce((a, b) => a + b, 0) / values.length;
    }
  }

  const durablyKnown =
    successes.length > 0 &&
    longest !== null &&
    longest >= DURABILITY_INTERVAL_DAYS;

  let questionInstead: string | null = null;
  if (!evidenceSufficient) {
    questionInstead =
      outcomes.length === 0
        ? 'When did you last use this?'
        : 'You have been tested on this once. Could you explain it now?';
  }

  return {
    conceptId,
    reviewCount: outcomes.length,
    lastSuccessfulRecallAt: lastSuccess,
    longestSuccessfulIntervalDays: longest,
    recentOutcomes: outcomes.slice(0, 10),
    modelledRecall,
    evidenceSufficient,
    durablyKnown,
    questionInstead,
  };
}

export interface CalibrationBin {
  /** Bin centre. */
  predicted: number;
  observed: number;
  n: number;
}

export interface CalibrationReport {
  bins: CalibrationBin[];
  /** Mean squared error of the predictions. Lower is better. */
  brier: number;
  /** Predictions minus outcomes. Positive means systematic overconfidence. */
  meanBias: number;
  reviewsWithPredictions: number;
  /**
   * Reviews excluded for having no prediction — almost always first exposures,
   * where the scheduler has no prior state and therefore makes no claim.
   *
   * Reported rather than dropped silently: a calibration figure computed over
   * an unstated subset of the data is exactly the kind of quiet omission that
   * makes a number untrustworthy. A client showing calibration should show
   * what it was computed over.
   */
  reviewsWithoutPredictions: number;
  asOf: string;
}

/**
 * Calibration: predicted recall against what actually happened.
 *
 * This is the gate for the entire retention feature. A well-calibrated model
 * that is only modestly accurate is useful and honest; a confident,
 * badly-calibrated one is the failure mode the design exists to avoid. A
 * retention engine that cannot report its own reliability is asking for trust
 * it has not earned (docs/12 §5).
 */
export async function calibration(
  db: SqlDriver,
  clock: Clock,
  opts: { bins?: number } = {},
): Promise<CalibrationReport> {
  const binCount = opts.bins ?? 10;

  const rows = await db.all<{
    predicted_recall: number; machine_rating: number | null;
    user_grade_override: number | null;
  }>(
    `SELECT predicted_recall, machine_rating, user_grade_override
       FROM review
      WHERE predicted_recall IS NOT NULL`,
  );

  const excluded = await db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM review WHERE predicted_recall IS NULL',
  );

  const buckets: { sumPredicted: number; successes: number; n: number }[] =
    Array.from({ length: binCount }, () => ({ sumPredicted: 0, successes: 0, n: 0 }));

  let squaredError = 0;
  let biasSum = 0;

  for (const r of rows) {
    const rating = r.user_grade_override ?? r.machine_rating;
    if (rating === null) continue;
    const success = rating >= PASSING_RATING ? 1 : 0;
    const p = r.predicted_recall;

    const idx = Math.min(binCount - 1, Math.floor(p * binCount));
    const bucket = buckets[idx]!;
    bucket.sumPredicted += p;
    bucket.successes += success;
    bucket.n++;

    squaredError += (p - success) ** 2;
    biasSum += p - success;
  }

  const n = buckets.reduce((acc, b) => acc + b.n, 0);

  return {
    bins: buckets
      .map((b) => ({
        predicted: b.n === 0 ? 0 : b.sumPredicted / b.n,
        observed: b.n === 0 ? 0 : b.successes / b.n,
        n: b.n,
      }))
      .filter((b) => b.n > 0),
    brier: n === 0 ? 0 : squaredError / n,
    meanBias: n === 0 ? 0 : biasSum / n,
    reviewsWithPredictions: n,
    reviewsWithoutPredictions: excluded?.n ?? 0,
    asOf: clock.now(),
  };
}

/**
 * Items whose pass rate is anomalous, as candidates for retirement.
 *
 * An item everyone always passes tests nothing; one nobody ever passes is
 * probably broken rather than hard. Both are quality signals worth surfacing
 * (docs/05 § Failure modes).
 */
export async function anomalousItems(
  db: SqlDriver,
  opts: { minReviews?: number } = {},
): Promise<{ quizItemId: string; reviews: number; passRate: number; overrideRate: number }[]> {
  const minReviews = opts.minReviews ?? 4;
  const rows = await db.all<{
    quiz_item_id: string; n: number; passes: number; overrides: number;
  }>(
    `SELECT quiz_item_id,
            COUNT(*) AS n,
            SUM(CASE WHEN COALESCE(user_grade_override, machine_rating) >= ${PASSING_RATING}
                     THEN 1 ELSE 0 END) AS passes,
            SUM(CASE WHEN user_grade_override IS NOT NULL THEN 1 ELSE 0 END) AS overrides
       FROM review
      WHERE quiz_item_id IS NOT NULL
      GROUP BY quiz_item_id
     HAVING COUNT(*) >= ?`,
    [minReviews],
  );

  return rows
    .map((r) => ({
      quizItemId: r.quiz_item_id,
      reviews: r.n,
      passRate: r.passes / r.n,
      overrideRate: r.overrides / r.n,
    }))
    .filter((r) => r.passRate === 0 || r.passRate === 1 || r.overrideRate >= 0.5);
}

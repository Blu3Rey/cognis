/**
 * Does telemetry-derived engagement actually improve scheduling?
 *
 * M5's completion criterion (docs/11-roadmap.md):
 *
 *   "telemetry-derived engagement measurably improves scheduler calibration
 *    versus the default-only baseline. If it does not, that is a real and
 *    publishable finding about the whole premise, and the reader's scope
 *    should shrink."
 *
 * This is a counterfactual replay: the same attested review log is scheduled
 * twice, once with the engagement prior and once with it neutralised, and each
 * run's predictions are scored against what actually happened. Nothing about
 * the comparison depends on the `predicted_recall` stored at the time, so it
 * can be re-run after the fact against history already collected.
 *
 * IMPORTANT: run against REAL review data. Run against simulated data where
 * engagement was used to generate the outcomes, this will report an
 * improvement that is an artifact of the simulation and means nothing.
 */

import type { SqlDriver } from '../ports/sql.js';
import { Scheduler } from '../retention/scheduler.js';
import type { ReviewRating, SchedulerOptions } from '../retention/scheduler.js';
import type { EngagementPrior } from '../reader/engagement-prior.js';
import {
  DEFAULT_ENGAGEMENT_PRIOR, NEUTRAL_ENGAGEMENT_PRIOR, multiplierFor,
} from '../reader/engagement-prior.js';
import type { Engagement } from '../types.js';

const PASSING_RATING = 3;

export interface ReplayScore {
  priorVersion: string;
  /** Mean squared error of predicted recall against outcome. Lower is better. */
  brier: number;
  /** Predictions minus outcomes. Positive means systematic overconfidence. */
  meanBias: number;
  /** Reviews that could be scored — first exposures make no prediction. */
  scored: number;
}

export interface EngagementComparison {
  withPrior: ReplayScore;
  withoutPrior: ReplayScore;
  /** Negative means the prior improved calibration. */
  brierDelta: number;
  improves: boolean;
  /** Reviews backed by a plausible telemetry session. */
  telemetryBackedReviews: number;
  /**
   * True when the comparison rests on enough telemetry-backed reviews to be
   * worth reading at all. Below this the delta is noise.
   */
  sufficientData: boolean;
  notes: string[];
}

export const MIN_REVIEWS_FOR_COMPARISON = 50;

interface ReviewRow {
  quiz_item_id: string;
  concept_id: string;
  presented_at: string;
  rating: number;
  engagement: string | null;
  telemetry_backed: number;
}

async function loadReplayRows(db: SqlDriver): Promise<ReviewRow[]> {
  return db.all<ReviewRow>(
    `SELECT r.quiz_item_id, r.concept_id, r.presented_at,
            COALESCE(r.user_grade_override, r.machine_rating, r.self_rating) AS rating,
            (
              SELECT ie.engagement
                FROM mention m
                JOIN chunk c ON c.id = m.chunk_id
                JOIN document_version dv ON dv.id = c.document_version_id
                JOIN ingestion_event ie ON ie.source_id = dv.source_id
               WHERE m.concept_id = r.concept_id AND ie.engagement IS NOT NULL
               ORDER BY ie.occurred_at DESC LIMIT 1
            ) AS engagement,
            (
              SELECT COUNT(*)
                FROM mention m
                JOIN chunk c ON c.id = m.chunk_id
                JOIN document_version dv ON dv.id = c.document_version_id
                JOIN ingestion_event ie ON ie.source_id = dv.source_id
                JOIN reading_session rs ON rs.ingestion_event_id = ie.id
               WHERE m.concept_id = r.concept_id AND rs.plausible = 1
            ) AS telemetry_backed
       FROM review r
      WHERE r.quiz_item_id IS NOT NULL
        AND COALESCE(r.user_grade_override, r.machine_rating, r.self_rating) IS NOT NULL
      ORDER BY r.presented_at, r.id`,
  );
}

function replay(
  rows: readonly ReviewRow[],
  scheduler: Scheduler,
  prior: EngagementPrior,
): ReplayScore {
  const byItem = new Map<string, ReviewRow[]>();
  for (const r of rows) {
    const list = byItem.get(r.quiz_item_id) ?? [];
    list.push(r);
    byItem.set(r.quiz_item_id, list);
  }

  let squaredError = 0;
  let biasSum = 0;
  let scored = 0;

  for (const [, itemReviews] of byItem) {
    let card = scheduler.newCard(new Date(itemReviews[0]!.presented_at));
    let first = true;

    for (const r of itemReviews) {
      const at = new Date(r.presented_at);
      const success = r.rating >= PASSING_RATING ? 1 : 0;

      // A first exposure has no prior state, so the scheduler makes no claim
      // and the review is not scorable — the same rule the live calibration
      // report applies.
      if (!first) {
        const predicted = scheduler.retrievability(card, at);
        squaredError += (predicted - success) ** 2;
        biasSum += predicted - success;
        scored++;
      }

      card = scheduler.apply(card, r.rating as ReviewRating, at);

      if (first) {
        const m = multiplierFor(prior, r.engagement as Engagement | null);
        if (m !== 1) {
          // Scale the initial stability, then let the scheduler's own dynamics
          // carry it forward untouched.
          card = { ...card, stability: card.stability * m };
        }
        first = false;
      }
    }
  }

  return {
    priorVersion: prior.version,
    brier: scored === 0 ? 0 : squaredError / scored,
    meanBias: scored === 0 ? 0 : biasSum / scored,
    scored,
  };
}

/**
 * Compare scheduling with and without the engagement prior.
 *
 * Returns the comparison whatever the data volume, with `sufficientData`
 * saying whether it is worth reading. Reporting a delta computed over eleven
 * reviews as though it settled the question would be exactly the false
 * precision this project keeps trying to avoid.
 */
export async function evaluateEngagementPrior(
  db: SqlDriver,
  opts: {
    prior?: EngagementPrior;
    scheduler?: SchedulerOptions;
    minReviews?: number;
  } = {},
): Promise<EngagementComparison> {
  const prior = opts.prior ?? DEFAULT_ENGAGEMENT_PRIOR;
  const minReviews = opts.minReviews ?? MIN_REVIEWS_FOR_COMPARISON;

  const rows = await loadReplayRows(db);
  const scheduler = new Scheduler(opts.scheduler ?? {});

  const withPrior = replay(rows, scheduler, prior);
  const withoutPrior = replay(rows, scheduler, NEUTRAL_ENGAGEMENT_PRIOR);

  const telemetryBacked = rows.filter((r) => r.telemetry_backed > 0).length;
  const notes: string[] = [];

  if (withPrior.scored < minReviews) {
    notes.push(
      `only ${withPrior.scored} scorable reviews; ` +
        `${minReviews} is the minimum for the delta to mean anything`,
    );
  }
  if (telemetryBacked === 0) {
    notes.push(
      'no reviews are backed by plausible telemetry, so the prior had nothing ' +
        'to act on and the two runs are expected to be identical',
    );
  }
  const engaged = rows.filter((r) => r.engagement !== null).length;
  if (engaged > 0 && telemetryBacked === 0) {
    notes.push(
      'engagement levels are present but self-asserted rather than ' +
        'telemetry-derived: this measures the prior, not the reader',
    );
  }

  const brierDelta = withPrior.brier - withoutPrior.brier;

  return {
    withPrior,
    withoutPrior,
    brierDelta,
    improves: brierDelta < 0,
    telemetryBackedReviews: telemetryBacked,
    sufficientData: withPrior.scored >= minReviews && telemetryBacked > 0,
    notes,
  };
}

export function formatEngagementComparison(c: EngagementComparison): string {
  const lines = [
    `with prior    (${c.withPrior.priorVersion}): Brier ${c.withPrior.brier.toFixed(4)} ` +
      `bias ${c.withPrior.meanBias.toFixed(4)} over ${c.withPrior.scored} reviews`,
    `without prior (${c.withoutPrior.priorVersion}): Brier ${c.withoutPrior.brier.toFixed(4)} ` +
      `bias ${c.withoutPrior.meanBias.toFixed(4)} over ${c.withoutPrior.scored} reviews`,
    `delta: ${c.brierDelta.toFixed(5)} (${c.improves ? 'prior helps' : 'prior does not help'})`,
    `telemetry-backed reviews: ${c.telemetryBackedReviews}`,
    `sufficient data: ${c.sufficientData ? 'yes' : 'NO — do not act on this'}`,
  ];
  for (const n of c.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

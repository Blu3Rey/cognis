/**
 * Scheduling, via a pinned FSRS implementation.
 *
 * ADR-0006: use an existing, well-tested scheduler from the FSRS line rather
 * than reproducing years of parameter fitting badly, and operate at ITEM scope
 * only — a concept is not an item, and inventing a concept-level stability
 * parameter that no review directly measures would be fabricated precision.
 *
 * Every memory state records the scheduler, its version and a hash of the
 * parameter vector, so a refit is auditable and reversible. State is derived:
 * it can be recomputed from the review log at any time, which is what makes
 * changing schedulers safe.
 */

import {
  fsrs, generatorParameters, createEmptyCard, Rating, State, FSRSVersion,
} from 'ts-fsrs';
import type { Card, FSRSParameters, Grade } from 'ts-fsrs';
import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';

export const SCHEDULER_NAME = 'ts-fsrs';
export const SCHEDULER_VERSION = FSRSVersion;

/** 1..4, matching FSRS ratings. */
export type ReviewRating = 1 | 2 | 3 | 4;

export const RATING_AGAIN: ReviewRating = 1;
export const RATING_HARD: ReviewRating = 2;
export const RATING_GOOD: ReviewRating = 3;
export const RATING_EASY: ReviewRating = 4;

/**
 * Thresholds mapping a continuous grader score to a discrete rating.
 *
 * Configuration, versioned with the scheduler parameters — not a magic
 * constant buried in code (docs/05 § Grading).
 */
export interface RatingThresholds {
  hard: number;
  good: number;
  easy: number;
}

export const DEFAULT_THRESHOLDS: RatingThresholds = {
  hard: 0.4,
  good: 0.7,
  easy: 0.92,
};

export function scoreToRating(
  score: number,
  t: RatingThresholds = DEFAULT_THRESHOLDS,
): ReviewRating {
  if (score >= t.easy) return RATING_EASY;
  if (score >= t.good) return RATING_GOOD;
  if (score >= t.hard) return RATING_HARD;
  return RATING_AGAIN;
}

export interface SchedulerOptions {
  /** Target retention. The one knob trading review volume against forgetting. */
  requestRetention?: number;
  thresholds?: RatingThresholds;
}

const STATE_NAMES: Record<number, string> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

/** Stable hash of the parameter vector, so a refit is identifiable. */
export function paramsHash(params: FSRSParameters): string {
  const canonical = JSON.stringify({
    w: params.w,
    request_retention: params.request_retention,
    maximum_interval: params.maximum_interval,
    enable_fuzz: params.enable_fuzz,
    enable_short_term: params.enable_short_term,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface MemoryStateRow {
  scope: 'item' | 'concept';
  scopeId: string;
  stability: number;
  difficulty: number;
  lastReviewAt: string | null;
  dueAt: string;
  reps: number;
  lapses: number;
  state: string;
  card: Card;
  schedulerVersion: string;
  paramsHash: string;
}

export class Scheduler {
  readonly params: FSRSParameters;
  readonly thresholds: RatingThresholds;
  readonly paramsHash: string;
  readonly #f: ReturnType<typeof fsrs>;

  constructor(opts: SchedulerOptions = {}) {
    this.params = generatorParameters({
      request_retention: opts.requestRetention ?? 0.9,
      // Fuzz randomises intervals to spread load. It is off here because the
      // interval must be reproducible from the review log for a rebuild to
      // produce the same state, and for calibration to be interpretable.
      enable_fuzz: false,
    });
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.paramsHash = paramsHash(this.params);
    this.#f = fsrs(this.params);
  }

  newCard(now: Date): Card {
    return createEmptyCard(now);
  }

  /** Probability of successful recall at `at`, given the card. */
  retrievability(card: Card, at: Date): number {
    return this.#f.get_retrievability(card, at, false) as number;
  }

  /** Apply a rating and return the updated card. */
  apply(card: Card, rating: ReviewRating, at: Date): Card {
    const scheduled = this.#f.repeat(card, at);
    return scheduled[rating as Grade].card;
  }

  stateName(card: Card): string {
    return STATE_NAMES[card.state] ?? 'new';
  }
}

function serialiseCard(card: Card): string {
  return JSON.stringify({
    ...card,
    due: new Date(card.due).toISOString(),
    last_review: card.last_review ? new Date(card.last_review).toISOString() : null,
  });
}

function deserialiseCard(json: string): Card {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    ...raw,
    due: new Date(raw['due'] as string),
    last_review: raw['last_review'] ? new Date(raw['last_review'] as string) : undefined,
  } as unknown as Card;
}

export async function loadMemoryState(
  db: SqlDriver,
  scope: 'item' | 'concept',
  scopeId: string,
): Promise<MemoryStateRow | null> {
  const r = await db.get<{
    scope: string; scope_id: string; stability: number; difficulty: number;
    last_review_at: string | null; due_at: string; reps: number; lapses: number;
    state: string; card_json: string; scheduler_version: string; params_hash: string;
  }>('SELECT * FROM memory_state WHERE scope = ? AND scope_id = ?', [scope, scopeId]);
  if (!r) return null;
  return {
    scope: r.scope as 'item' | 'concept',
    scopeId: r.scope_id,
    stability: r.stability,
    difficulty: r.difficulty,
    lastReviewAt: r.last_review_at,
    dueAt: r.due_at,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    card: deserialiseCard(r.card_json),
    schedulerVersion: r.scheduler_version,
    paramsHash: r.params_hash,
  };
}

export async function saveMemoryState(
  db: SqlDriver,
  scheduler: Scheduler,
  scope: 'item' | 'concept',
  scopeId: string,
  card: Card,
): Promise<void> {
  await db.run(
    `INSERT INTO memory_state
       (scope, scope_id, stability, difficulty, last_review_at, due_at, reps,
        lapses, state, card_json, scheduler, scheduler_version, params_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (scope, scope_id) DO UPDATE SET
       stability = excluded.stability,
       difficulty = excluded.difficulty,
       last_review_at = excluded.last_review_at,
       due_at = excluded.due_at,
       reps = excluded.reps,
       lapses = excluded.lapses,
       state = excluded.state,
       card_json = excluded.card_json,
       scheduler = excluded.scheduler,
       scheduler_version = excluded.scheduler_version,
       params_hash = excluded.params_hash`,
    [
      scope, scopeId, card.stability, card.difficulty,
      card.last_review ? new Date(card.last_review).toISOString() : null,
      new Date(card.due).toISOString(), card.reps, card.lapses,
      scheduler.stateName(card), serialiseCard(card),
      SCHEDULER_NAME, SCHEDULER_VERSION, scheduler.paramsHash,
    ],
  );
}

/**
 * Rebuild every memory state by replaying the review log.
 *
 * This is why memory state is derived: a parameter refit or a scheduler
 * upgrade is a recompute, not a migration. Reviews are replayed in
 * presentation order, using the rating the user's override selected where one
 * exists, because that override is the more authoritative judgment.
 */
export async function rebuildMemoryStates(
  db: SqlDriver,
  clock: Clock,
  scheduler: Scheduler,
): Promise<{ items: number; reviewsReplayed: number }> {
  const reviews = await db.all<{
    quiz_item_id: string | null; presented_at: string;
    machine_rating: number | null; user_grade_override: number | null;
    self_rating: number | null;
  }>(
    `SELECT quiz_item_id, presented_at, machine_rating, user_grade_override, self_rating
       FROM review
      WHERE quiz_item_id IS NOT NULL
      ORDER BY presented_at, id`,
  );

  const byItem = new Map<string, typeof reviews>();
  for (const r of reviews) {
    if (!r.quiz_item_id) continue;
    const list = byItem.get(r.quiz_item_id) ?? [];
    list.push(r);
    byItem.set(r.quiz_item_id, list);
  }

  let replayed = 0;
  await db.transaction(async () => {
    await db.run(`DELETE FROM memory_state WHERE scope = 'item'`);
    for (const [itemId, itemReviews] of byItem) {
      const first = itemReviews[0]!;
      let card = scheduler.newCard(new Date(first.presented_at));
      for (const r of itemReviews) {
        const rating = (r.user_grade_override ?? r.machine_rating ?? r.self_rating) as
          | ReviewRating
          | null;
        if (rating === null) continue;
        card = scheduler.apply(card, rating, new Date(r.presented_at));
        replayed++;
      }
      await saveMemoryState(db, scheduler, 'item', itemId, card);
    }
  });

  void clock;
  return { items: byItem.size, reviewsReplayed: replayed };
}

export { Rating, State };
export type { Card, FSRSParameters };

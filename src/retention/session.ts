/**
 * Review session assembly and the review write path.
 *
 * Three constraints from docs/05 § Session assembly, all of them enforced here
 * rather than left to the client: a daily budget, interleaving, and respecting
 * the schedule. Overdue backlogs are how spaced-repetition products die, and a
 * client that forgets the cap would rebuild that failure.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type { Grader } from '../ports/grader.js';
import type { Ulid } from '../types.js';
import { ulid } from '../ids.js';
import {
  Scheduler, loadMemoryState, saveMemoryState, scoreToRating,
} from './scheduler.js';
import type { ReviewRating } from './scheduler.js';
import { parseRubric, parseEvidence } from './items.js';
import { withEgress } from '../privacy/egress.js';
import { redactText } from '../privacy/redact.js';

export interface ReviewCard {
  quizItemId: Ulid;
  conceptId: string;
  conceptLabel: string;
  kind: string;
  prompt: string;
  dueAt: string | null;
  /** The model's prediction at assembly time. Stored on the review. */
  predictedRecall: number | null;
  intervalDays: number | null;
}

export interface SessionOptions {
  /** Hard cap on items per session. Default is deliberately small. */
  limit?: number;
  at?: string;
  /** Include items never reviewed. */
  includeNew?: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Assemble a review session.
 *
 * Ordering is by "closest to the forgetting threshold" rather than by age: a
 * strict oldest-first queue punishes a missed day with a wall of the least
 * useful reviews. Concepts are then interleaved, since interleaving lowers
 * in-session performance and raises retention, and retention is what we want.
 */
export async function dueItems(
  db: SqlDriver,
  clock: Clock,
  scheduler: Scheduler,
  opts: SessionOptions = {},
): Promise<ReviewCard[]> {
  const limit = opts.limit ?? 20;
  const at = opts.at ?? clock.now();
  const includeNew = opts.includeNew ?? true;

  const rows = await db.all<{
    id: string; concept_id: string; label: string; kind: string; prompt: string;
    due_at: string | null; card_json: string | null; last_review_at: string | null;
  }>(
    `SELECT qi.id, qi.concept_id, c.label, qi.kind, qi.prompt,
            ms.due_at, ms.card_json, ms.last_review_at
       FROM quiz_item qi
       JOIN concept c ON c.id = qi.concept_id
       LEFT JOIN memory_state ms
              ON ms.scope = 'item' AND ms.scope_id = qi.id
      WHERE qi.retired_at IS NULL
        AND (ms.due_at IS NULL OR ms.due_at <= ?)`,
    [at],
  );

  const now = new Date(at);
  const scored: (ReviewCard & { priority: number; conceptId: string })[] = [];

  for (const r of rows) {
    if (!r.card_json && !includeNew) continue;

    let predicted: number | null = null;
    let intervalDays: number | null = null;

    if (r.card_json) {
      const state = await loadMemoryState(db, 'item', r.id);
      if (state) {
        predicted = scheduler.retrievability(state.card, now);
        if (state.lastReviewAt) {
          intervalDays = (now.getTime() - Date.parse(state.lastReviewAt)) / DAY_MS;
        }
      }
    }

    // Items nearest the target retention are the ones worth spending a
    // session on. New items sort just behind genuinely urgent ones.
    const priority =
      predicted === null
        ? 0.5
        : 1 - Math.abs(predicted - scheduler.params.request_retention);

    scored.push({
      quizItemId: r.id,
      conceptId: r.concept_id,
      conceptLabel: r.label,
      kind: r.kind,
      prompt: r.prompt,
      dueAt: r.due_at,
      predictedRecall: predicted,
      intervalDays,
      priority,
    });
  }

  scored.sort((a, b) => b.priority - a.priority || a.quizItemId.localeCompare(b.quizItemId));

  // Interleave: round-robin across concepts so a session does not block on one
  // topic, which feels easier and retains worse.
  const byConcept = new Map<string, typeof scored>();
  for (const s of scored) {
    const list = byConcept.get(s.conceptId) ?? [];
    list.push(s);
    byConcept.set(s.conceptId, list);
  }
  const queues = [...byConcept.values()];
  const interleaved: typeof scored = [];
  let index = 0;
  while (interleaved.length < Math.min(limit, scored.length)) {
    const queue = queues[index % queues.length]!;
    const next = queue.shift();
    if (next) interleaved.push(next);
    index++;
    if (queues.every((q) => q.length === 0)) break;
  }

  return interleaved.slice(0, limit).map(({ priority: _p, ...card }) => card);
}

export interface SubmitReviewInput {
  quizItemId: Ulid;
  answerText: string;
  selfRating?: ReviewRating;
  presentedAt: string;
  answeredAt: string;
  /** Captured at presentation time, before the answer was seen. */
  predictedRecall?: number | null;
  intervalDays?: number | null;
}

export interface ReviewResult {
  reviewId: Ulid;
  score: number;
  rating: ReviewRating;
  points: { pointId: string; met: boolean; note?: string }[];
  rationaleForUser: string;
  nextDueAt: string;
}

/**
 * Grade an answer, record the review, and advance the schedule.
 *
 * The raw answer is stored verbatim before grading is applied, so a grader
 * failure still leaves the attested record intact.
 */
export async function submitReview(
  db: SqlDriver,
  clock: Clock,
  scheduler: Scheduler,
  grader: Grader,
  input: SubmitReviewInput,
): Promise<ReviewResult> {
  const item = await db.get<{
    id: string; concept_id: string; prompt: string;
    expected_points_json: string; evidence_json: string;
  }>('SELECT * FROM quiz_item WHERE id = ?', [input.quizItemId]);
  if (!item) throw new Error(`no such quiz item: ${input.quizItemId}`);

  const points = parseRubric(item.expected_points_json);
  const evidence = parseEvidence(item.evidence_json);

  const redactedAnswer = redactText(input.answerText);
  const request = {
    prompt: item.prompt,
    answerText: redactedAnswer.value,
    expectedPoints: points,
    evidenceText: evidence.map((e) => e.text).join('\n\n'),
  };

  // The grade is a judgment that leaves the device; the raw answer stored
  // below is not the redacted one, because that is the attested evidence.
  const grade = await withEgress(
    db, clock,
    {
      destination: 'model_proxy',
      purpose: 'grade',
      sourceIds: [...new Set(evidence.map((e) => e.sourceId))],
      bytesSent: JSON.stringify(request).length,
      redactions: redactedAnswer.redactions,
    },
    () => grader.grade(request),
  );

  const rating = scoreToRating(grade.score, scheduler.thresholds);
  const reviewId = ulid(clock.nowMs());
  const latency = Date.parse(input.answeredAt) - Date.parse(input.presentedAt);

  const state = await loadMemoryState(db, 'item', input.quizItemId);
  const card = state?.card ?? scheduler.newCard(new Date(input.presentedAt));
  const nextCard = scheduler.apply(card, rating, new Date(input.answeredAt));

  await db.transaction(async () => {
    await db.run(
      `INSERT INTO review
         (id, quiz_item_id, item_prompt_snapshot, concept_id, presented_at,
          answered_at, latency_ms, answer_text, self_rating, machine_grade,
          machine_rating, grade_rubric_version, grade_model_id,
          user_grade_override, scheduled_for, predicted_recall, interval_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        reviewId, item.id, item.prompt, item.concept_id, input.presentedAt,
        input.answeredAt, Number.isFinite(latency) ? latency : null,
        input.answerText, input.selfRating ?? null, grade.score, rating,
        grader.rubricVersion, grader.modelId,
        state?.dueAt ?? null,
        input.predictedRecall ?? null, input.intervalDays ?? null,
      ],
    );
    await saveMemoryState(db, scheduler, 'item', input.quizItemId, nextCard);
  });

  return {
    reviewId,
    score: grade.score,
    rating,
    points: grade.points,
    rationaleForUser: grade.rationaleForUser,
    nextDueAt: new Date(nextCard.due).toISOString(),
  };
}

/**
 * Override a grade.
 *
 * Disagreement is signal: a cluster of overrides on one rubric points at a bad
 * item, and this is the cheapest quality feedback available. The override
 * changes the schedule, because the user's judgment is the better one.
 */
export async function overrideGrade(
  db: SqlDriver,
  scheduler: Scheduler,
  reviewId: Ulid,
  rating: ReviewRating,
): Promise<{ nextDueAt: string }> {
  const review = await db.get<{
    quiz_item_id: string | null; presented_at: string; answered_at: string | null;
  }>('SELECT quiz_item_id, presented_at, answered_at FROM review WHERE id = ?', [reviewId]);
  if (!review) throw new Error(`no such review: ${reviewId}`);

  await db.run('UPDATE review SET user_grade_override = ? WHERE id = ?', [
    rating, reviewId,
  ]);

  if (!review.quiz_item_id) return { nextDueAt: '' };

  // Recompute from the previous state rather than from the already-advanced
  // one, so an override replaces the machine rating instead of stacking on it.
  const state = await loadMemoryState(db, 'item', review.quiz_item_id);
  const at = new Date(review.answered_at ?? review.presented_at);
  const base = state?.card ?? scheduler.newCard(new Date(review.presented_at));
  const next = scheduler.apply(base, rating, at);
  await saveMemoryState(db, scheduler, 'item', review.quiz_item_id, next);
  return { nextDueAt: new Date(next.due).toISOString() };
}

/**
 * When the next review falls due.
 *
 * The retention engine is, operationally, a notification scheduler: reviews
 * delivered when convenient rather than when due destroy the effect being
 * measured and corrupt the interval data. Core computes the time; the client
 * delivers it.
 */
export async function nextDueAt(db: SqlDriver): Promise<string | null> {
  const row = await db.get<{ due_at: string }>(
    `SELECT MIN(due_at) AS due_at FROM memory_state WHERE scope = 'item'`,
  );
  return row?.due_at ?? null;
}

/** How many items fall due on a given day, for planning notifications. */
export async function dueCountOn(
  db: SqlDriver,
  day: string,
): Promise<number> {
  const start = day.slice(0, 10) + 'T00:00:00.000Z';
  const end = new Date(Date.parse(start) + DAY_MS).toISOString();
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM memory_state
      WHERE scope = 'item' AND due_at >= ? AND due_at < ?`,
    [start, end],
  );
  return row?.n ?? 0;
}

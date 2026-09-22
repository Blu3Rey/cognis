/**
 * Reading telemetry: ingestion, plausibility guards, engagement derivation.
 *
 * The reader's one irreplaceable contribution is this signal
 * (ADR-0007): dwell time, scroll depth and reversals are the objective
 * engagement-depth measure, and engagement depth is the ingestion variable
 * with the strongest claim to predicting durable retention.
 *
 * It is also the signal easiest to fool. A phone left open on an article
 * reports twenty minutes of "reading", so the guards below are not polish —
 * without them the variable is noise with a plausible unit attached.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Engagement, Ulid } from '../types.js';
import { ulid } from '../ids.js';

export const TELEMETRY_VERSION = '1.0.0';

/**
 * Words per minute used to bound a plausible reading time.
 *
 * Deliberately generous at the top end: the cap exists to reject a phone left
 * on a table, not to police fast readers.
 */
export const READING_WPM = 240;
/** Active time beyond this multiple of expected reading time is not reading. */
export const MAX_TIME_MULTIPLE = 3;
/** Below this fraction of expected time, the content cannot have been read. */
export const MIN_READ_FRACTION = 0.5;
/** Scroll depth required before a session counts as having been read. */
export const READ_SCROLL_PCT = 0.8;
/** Sessions shorter than this are opens, not reads. */
export const MIN_SESSION_MS = 3_000;

export interface RawTelemetry {
  ingestionEventId: Ulid;
  startedAt: string;
  endedAt: string;
  /** Foreground, screen-on time, excluding idle gaps. Reported by the client. */
  activeMs: number;
  maxScrollPct?: number | null;
  scrollReversals?: number | null;
  estWordsVisible?: number | null;
}

export interface PlausibilityVerdict {
  plausible: boolean;
  reason: string | null;
  cappedActiveMs: number;
  expectedReadingMs: number;
}

/**
 * Judge whether a session can be believed.
 *
 * Returns a verdict rather than throwing or dropping: the session is recorded
 * either way, marked with why it is not trustworthy.
 */
export function assessPlausibility(
  t: RawTelemetry,
  wordCount: number,
): PlausibilityVerdict {
  const expectedReadingMs = Math.max(
    1_000,
    Math.round((wordCount / READING_WPM) * 60_000),
  );
  const cappedActiveMs = Math.min(t.activeMs, expectedReadingMs * MAX_TIME_MULTIPLE);

  if (t.activeMs < MIN_SESSION_MS) {
    return {
      plausible: false,
      reason: 'session too short to be reading',
      cappedActiveMs, expectedReadingMs,
    };
  }

  const scrolled = (t.maxScrollPct ?? 0) > 0 || (t.scrollReversals ?? 0) > 0;
  if (!scrolled) {
    // No scroll events at all is the signature of an open page nobody is
    // looking at — the single most common way dwell time lies.
    return {
      plausible: false,
      reason: 'no scroll events: page open but not read',
      cappedActiveMs, expectedReadingMs,
    };
  }

  if (t.activeMs > expectedReadingMs * MAX_TIME_MULTIPLE) {
    return {
      plausible: false,
      reason: `active time ${Math.round(t.activeMs / 1000)}s exceeds ` +
        `${MAX_TIME_MULTIPLE}x the expected ${Math.round(expectedReadingMs / 1000)}s`,
      cappedActiveMs, expectedReadingMs,
    };
  }

  const elapsed = Date.parse(t.endedAt) - Date.parse(t.startedAt);
  if (Number.isFinite(elapsed) && t.activeMs > elapsed + 1_000) {
    return {
      plausible: false,
      reason: 'active time exceeds wall-clock duration',
      cappedActiveMs, expectedReadingMs,
    };
  }

  return { plausible: true, reason: null, cappedActiveMs, expectedReadingMs };
}

/**
 * Derive engagement depth from a plausible session.
 *
 * Only `skim` and `read` can be established this way. `annotate` comes from
 * evidence (an annotation exists); `apply` and `teach` can only be asserted by
 * the user, and no amount of scrolling establishes them
 * (docs/03-ingestion.md § Engagement depth).
 */
export function deriveEngagement(
  verdict: PlausibilityVerdict,
  t: RawTelemetry,
): Engagement | null {
  if (!verdict.plausible) return null;

  const enoughTime =
    verdict.cappedActiveMs >= verdict.expectedReadingMs * MIN_READ_FRACTION;
  const enoughScroll = (t.maxScrollPct ?? 0) >= READ_SCROLL_PCT;

  if (enoughTime && enoughScroll) return 'read';
  return 'skim';
}

export interface RecordTelemetryResult {
  readingSessionId: Ulid;
  verdict: PlausibilityVerdict;
  derivedEngagement: Engagement | null;
  engagementApplied: boolean;
}

/**
 * Record a reading session and, when it is trustworthy, let it raise the
 * ingestion event's engagement level.
 *
 * Engagement never downgrades, so a later quick revisit cannot erase a deeper
 * earlier engagement.
 */
export async function recordTelemetry(
  db: SqlDriver,
  t: RawTelemetry,
): Promise<RecordTelemetryResult> {
  const doc = await db.get<{ word_count: number }>(
    `SELECT dv.word_count AS word_count
       FROM ingestion_event ie
       JOIN document_version dv ON dv.source_id = ie.source_id
      WHERE ie.id = ?
      ORDER BY dv.extracted_at DESC
      LIMIT 1`,
    [t.ingestionEventId],
  );
  // With no extracted text we cannot judge plausibility by reading rate, so
  // fall back to a conservative assumption rather than inventing a word count.
  const wordCount = doc?.word_count ?? 0;

  const verdict = assessPlausibility(t, wordCount || 400);
  const derived = deriveEngagement(verdict, t);
  const id = ulid();

  await db.run(
    `INSERT INTO reading_session
       (id, ingestion_event_id, started_at, ended_at, active_ms, max_scroll_pct,
        scroll_reversals, est_words_visible, plausible, implausible_reason,
        capped_active_ms, expected_reading_ms, producer_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, t.ingestionEventId, t.startedAt, t.endedAt, t.activeMs,
      t.maxScrollPct ?? null, t.scrollReversals ?? null, t.estWordsVisible ?? null,
      verdict.plausible ? 1 : 0, verdict.reason,
      verdict.cappedActiveMs, verdict.expectedReadingMs, TELEMETRY_VERSION,
    ],
  );

  let engagementApplied = false;
  if (derived) {
    const { recordEngagement } = await import('../capture/capture.js');
    const res = await recordEngagement(db, t.ingestionEventId, derived, 'telemetry');
    engagementApplied = res.applied;
  }

  return { readingSessionId: id, verdict, derivedEngagement: derived, engagementApplied };
}

/**
 * Prior coverage — the "have I seen this before?" answer returned at capture
 * time. See docs/10-api-contract.md § Capture.
 *
 * In M0 this is built entirely from attested rows. Novelty arrives in M1 with
 * on-device embeddings, and related concepts in M2 with concept linking; both
 * fields exist now and are null, so the client's shape does not change when
 * they start being populated.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Engagement, Timestamp, Ulid } from '../types.js';
import type { IngestionEventRow } from './rows.js';
import { toIngestionEvent } from './rows.js';

export interface PriorCoverage {
  seenBefore: boolean;
  /** Earlier encounters with this source, most recent first. */
  previousEvents: { occurredAt: Timestamp; engagement: Engagement | null }[];
  /** Populated from M2. */
  relatedConcepts: { conceptId: string; label: string; distinctSources: number }[];
  /** Populated from M1. */
  novelty: number | null;
  noveltyModelId: string | null;
}

export async function priorCoverageFor(
  db: SqlDriver,
  sourceId: Ulid,
  excludeEventId?: Ulid,
): Promise<PriorCoverage> {
  const rows = await db.all<IngestionEventRow>(
    `SELECT * FROM ingestion_event
      WHERE source_id = ? AND (? IS NULL OR id <> ?)
      ORDER BY occurred_at DESC`,
    [sourceId, excludeEventId ?? null, excludeEventId ?? ''],
  );

  const events = rows.map(toIngestionEvent);
  const withNovelty = events.find((e) => e.novelty !== null);

  return {
    seenBefore: events.length > 0,
    previousEvents: events.map((e) => ({
      occurredAt: e.occurredAt,
      engagement: e.engagement,
    })),
    relatedConcepts: [],
    novelty: withNovelty?.novelty ?? null,
    noveltyModelId: withNovelty?.noveltyModelId ?? null,
  };
}

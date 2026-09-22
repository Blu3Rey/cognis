/**
 * Cognis — the facade the client consumes.
 *
 * Implements the M0 slice of docs/10-api-contract.md. Composition only: the
 * logic lives in the modules this delegates to, so each piece stays testable
 * on its own.
 */

import type { SqlDriver } from './ports/sql.js';
import type { Clock } from './ports/clock.js';
import { systemClock } from './ports/clock.js';
import { migrate } from './db/migrate.js';
import type { MigrateResult } from './db/migrate.js';
import {
  capture, recordEngagement, recordExtraction, recordExtractionFailure,
} from './capture/capture.js';
import type { CaptureInput, CaptureResult } from './capture/capture.js';
import { priorCoverageFor } from './capture/prior-coverage.js';
import type { PriorCoverage } from './capture/prior-coverage.js';
import { deleteSource } from './capture/delete.js';
import type { DeleteReport } from './capture/delete.js';
import { exportJsonl, exportJsonlString, importJsonl, linesOf } from './export/jsonl.js';
import type { ImportReport } from './export/jsonl.js';
import { toSource, toIngestionEvent } from './capture/rows.js';
import type { SourceRow, IngestionEventRow } from './capture/rows.js';
import type {
  Annotation, AnnotationKind, Engagement, EngagementSource, IngestionEvent,
  Source, Timestamp, Ulid,
} from './types.js';
import { ulid } from './ids.js';

export interface CognisOptions {
  db: SqlDriver;
  clock?: Clock;
}

export class Cognis {
  readonly db: SqlDriver;
  readonly clock: Clock;

  constructor(opts: CognisOptions) {
    this.db = opts.db;
    this.clock = opts.clock ?? systemClock;
  }

  /** Apply pending migrations. Safe to call on every startup. */
  async migrate(): Promise<MigrateResult> {
    return migrate(this.db, this.clock);
  }

  // -- Capture -------------------------------------------------------------

  async capture(input: CaptureInput): Promise<CaptureResult> {
    return capture(this.db, this.clock, input);
  }

  async recordExtraction(args: {
    sourceId: Ulid;
    ingestionEventId: Ulid;
    text: string;
    textHash: string;
    lang?: string | null;
    producer: string;
    producerVersion: string;
  }): Promise<{ documentVersionId: Ulid; created: boolean }> {
    return recordExtraction(this.db, this.clock, args);
  }

  async recordExtractionFailure(ingestionEventId: Ulid, reason: string): Promise<void> {
    return recordExtractionFailure(this.db, ingestionEventId, reason);
  }

  async recordEngagement(
    ingestionEventId: Ulid,
    level: Engagement,
    source: EngagementSource,
  ): Promise<{ applied: boolean }> {
    return recordEngagement(this.db, ingestionEventId, level, source);
  }

  async annotate(
    documentVersionId: Ulid,
    a: {
      kind: AnnotationKind;
      startChar?: number | null;
      endChar?: number | null;
      quotedText?: string | null;
      body?: string | null;
    },
  ): Promise<{ annotationId: Ulid }> {
    const id = ulid(this.clock.nowMs());
    await this.db.run(
      `INSERT INTO annotation
         (id, document_version_id, kind, start_char, end_char, quoted_text, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, documentVersionId, a.kind, a.startChar ?? null, a.endChar ?? null,
        a.quotedText ?? null, a.body ?? null, this.clock.now(),
      ],
    );
    return { annotationId: id };
  }

  // -- Reads ---------------------------------------------------------------

  async getSource(sourceId: Ulid): Promise<Source | null> {
    const row = await this.db.get<SourceRow>('SELECT * FROM source WHERE id = ?', [
      sourceId,
    ]);
    return row ? toSource(row) : null;
  }

  async priorCoverage(sourceId: Ulid): Promise<PriorCoverage> {
    return priorCoverageFor(this.db, sourceId);
  }

  /** Capture history, newest first. The minimal "what did I capture, when" list. */
  async recentEvents(limit = 50): Promise<(IngestionEvent & { source: Source })[]> {
    const rows = await this.db.all<IngestionEventRow & SourceRow & { s_id: string }>(
      `SELECT e.*, s.id AS s_id, s.kind, s.canonical_url, s.doi, s.isbn,
              s.content_hash, s.title, s.authors_json, s.published_at,
              s.first_seen_at, s.is_private
         FROM ingestion_event e
         JOIN source s ON s.id = e.source_id
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      ...toIngestionEvent(r),
      source: toSource({ ...r, id: r.s_id }),
    }));
  }

  async annotationsFor(documentVersionId: Ulid): Promise<Annotation[]> {
    const rows = await this.db.all<{
      id: string; document_version_id: string; kind: string;
      start_char: number | null; end_char: number | null;
      quoted_text: string | null; body: string | null; created_at: string;
    }>(
      'SELECT * FROM annotation WHERE document_version_id = ? ORDER BY id',
      [documentVersionId],
    );
    return rows.map((r) => ({
      id: r.id,
      documentVersionId: r.document_version_id,
      kind: r.kind as AnnotationKind,
      startChar: r.start_char,
      endChar: r.end_char,
      quotedText: r.quoted_text,
      body: r.body,
      createdAt: r.created_at as Timestamp,
    }));
  }

  // -- Data rights ---------------------------------------------------------

  exportJsonl(): AsyncGenerator<string> {
    return exportJsonl(this.db, this.clock);
  }

  async exportJsonlString(): Promise<string> {
    return exportJsonlString(this.db, this.clock);
  }

  async importJsonlString(text: string): Promise<ImportReport> {
    return importJsonl(this.db, linesOf(text));
  }

  async deleteSource(sourceId: Ulid): Promise<DeleteReport> {
    return deleteSource(this.db, sourceId);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

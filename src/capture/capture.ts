/**
 * Capture — the attested write path.
 *
 * The invariant this module exists to protect: once the user has encountered
 * something, that fact is recorded and never lost, whatever happens to the
 * pipeline afterwards. Extraction can fail, models can decline, the network
 * can be absent; the `source` and `ingestion_event` rows still stand.
 *
 * See docs/03-ingestion.md and docs/10-api-contract.md § Capture.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Clock } from '../ports/clock.js';
import type {
  CapturePath, Engagement, EngagementSource, IngestionStatus,
  Source, SourceKind, Timestamp, Ulid,
} from '../types.js';
import { ulid } from '../ids.js';
import { canonicaliseUrl } from '../canonical/url.js';
import { normaliseDoi, arxivDoi, arxivIdFromUrl } from '../canonical/doi.js';
import { toSource, toIngestionEvent } from './rows.js';
import type { SourceRow, IngestionEventRow } from './rows.js';
import type { PriorCoverage } from './prior-coverage.js';
import { priorCoverageFor } from './prior-coverage.js';

export interface CaptureInput {
  kind: 'url' | 'pdf' | 'text' | 'doi';
  /** URL, file path, raw text, or DOI, according to `kind`. */
  payload: string;
  capturePath: CapturePath;
  occurredAt?: Timestamp;
  /** Publisher metadata, when the caller already has it. Never model-authored. */
  title?: string;
  authors?: string[];
  publishedAt?: Timestamp;
  /** rel=canonical, when the extractor found one. Outranks the requested URL. */
  relCanonical?: string;
  /** Final URL after redirects, when the fetcher resolved them. */
  resolvedUrl?: string;
  /** Hash of the original bytes, for file imports. */
  contentHash?: string;
  /** Exclude from all egress, permanently. See docs/09. */
  isPrivate?: boolean;
}

export interface CaptureResult {
  sourceId: Ulid;
  ingestionEventId: Ulid;
  /** True when this capture attached to an existing source. */
  reEncounter: boolean;
  priorCoverage: PriorCoverage;
}

function sourceKindFor(input: CaptureInput): SourceKind {
  switch (input.kind) {
    case 'pdf': return 'pdf';
    case 'doi': return 'paper';
    case 'text': return 'note';
    case 'url': return 'web';
  }
}

interface ResolvedIdentity {
  canonicalUrl: string | null;
  doi: string | null;
  kind: SourceKind;
}

/**
 * Work out the identity a capture should resolve to.
 *
 * Order matters: a DOI outranks a URL, because it collapses the publisher
 * page, the PDF, the preprint and every mirror into one source.
 */
export function resolveIdentity(input: CaptureInput): ResolvedIdentity {
  let kind = sourceKindFor(input);

  if (input.kind === 'doi') {
    const doi = normaliseDoi(input.payload);
    if (!doi) throw new TypeError(`not a DOI: ${input.payload}`);
    return { canonicalUrl: null, doi, kind: 'paper' };
  }

  if (input.kind === 'text') {
    return { canonicalUrl: null, doi: null, kind: 'note' };
  }

  // url | pdf
  let canonicalUrl: string | null = null;
  let doi: string | null = null;
  try {
    const c = canonicaliseUrl(input.payload, {
      relCanonical: input.relCanonical,
      resolvedUrl: input.resolvedUrl,
    });
    canonicalUrl = c.url;
    // A DOI discoverable from the URL upgrades this to a paper.
    doi = normaliseDoi(input.payload);
    if (!doi) {
      const arxiv = arxivIdFromUrl(input.payload);
      if (arxiv) doi = arxivDoi(arxiv);
    }
    if (doi) kind = 'paper';
  } catch (err) {
    // A local file path is not a URL, which is fine for a pdf import, but a
    // capture that claimed to be a URL and is not should fail loudly.
    if (input.kind === 'url') throw err;
  }

  return { canonicalUrl, doi, kind };
}

/** Find an existing source by DOI, then canonical URL, then content hash. */
async function findExisting(
  db: SqlDriver,
  identity: ResolvedIdentity,
  contentHash: string | undefined,
): Promise<Source | null> {
  if (identity.doi) {
    const row = await db.get<SourceRow>('SELECT * FROM source WHERE doi = ?', [
      identity.doi,
    ]);
    if (row) return toSource(row);
  }
  if (identity.canonicalUrl) {
    const row = await db.get<SourceRow>(
      'SELECT * FROM source WHERE canonical_url = ?',
      [identity.canonicalUrl],
    );
    if (row) return toSource(row);
  }
  if (contentHash) {
    const row = await db.get<SourceRow>(
      'SELECT * FROM source WHERE content_hash = ?',
      [contentHash],
    );
    if (row) return toSource(row);
  }
  return null;
}

/**
 * Capture a source.
 *
 * Returns as soon as the attested rows are written. Everything downstream
 * (extraction, chunking, embedding) is queued separately.
 *
 * Re-encountering a source is NOT a duplicate: it appends a second ingestion
 * event, which is exactly the signal coverage and spacing are built from.
 */
export async function capture(
  db: SqlDriver,
  clock: Clock,
  input: CaptureInput,
): Promise<CaptureResult> {
  const identity = resolveIdentity(input);
  const occurredAt = input.occurredAt ?? clock.now();

  return db.transaction(async () => {
    const existing = await findExisting(db, identity, input.contentHash);

    let sourceId: Ulid;
    let reEncounter: boolean;

    if (existing) {
      sourceId = existing.id;
      reEncounter = true;
      // Backfill identity we did not have the first time. A source first seen
      // as a bare URL may later be recognised as a paper with a DOI, and that
      // upgrade must not create a second source.
      if (identity.doi && !existing.doi) {
        await db.run('UPDATE source SET doi = ?, kind = ? WHERE id = ?', [
          identity.doi, 'paper', sourceId,
        ]);
      }
      if (identity.canonicalUrl && !existing.canonicalUrl) {
        await db.run('UPDATE source SET canonical_url = ? WHERE id = ?', [
          identity.canonicalUrl, sourceId,
        ]);
      }
    } else {
      sourceId = ulid(clock.nowMs());
      reEncounter = false;
      await db.run(
        `INSERT INTO source
           (id, kind, canonical_url, doi, isbn, content_hash, title,
            authors_json, published_at, first_seen_at, is_private)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          identity.kind,
          identity.canonicalUrl,
          identity.doi,
          null,
          input.contentHash ?? null,
          input.title ?? null,
          input.authors ? JSON.stringify(input.authors) : null,
          input.publishedAt ?? null,
          occurredAt,
          input.isPrivate ? 1 : 0,
        ],
      );
    }

    const eventId = ulid(clock.nowMs());
    await db.run(
      `INSERT INTO ingestion_event
         (id, source_id, occurred_at, capture_path, engagement,
          engagement_source, novelty, novelty_model_id, status, status_reason)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'captured', NULL)`,
      [eventId, sourceId, occurredAt, input.capturePath],
    );

    const priorCoverage = await priorCoverageFor(db, sourceId, eventId);
    return { sourceId, ingestionEventId: eventId, reEncounter, priorCoverage };
  });
}

/** Record a successful extraction and advance the event's status. */
export async function recordExtraction(
  db: SqlDriver,
  clock: Clock,
  args: {
    sourceId: Ulid;
    ingestionEventId: Ulid;
    text: string;
    textHash: string;
    lang?: string | null;
    producer: string;
    producerVersion: string;
  },
): Promise<{ documentVersionId: Ulid; created: boolean }> {
  const wordCount = args.text.trim() ? args.text.trim().split(/\s+/).length : 0;

  return db.transaction(async () => {
    // A re-extraction that produces identical text is not a new version;
    // annotations anchor to versions, so churning them would orphan anchors.
    const existing = await db.get<{ id: string }>(
      'SELECT id FROM document_version WHERE source_id = ? AND text_hash = ?',
      [args.sourceId, args.textHash],
    );

    let documentVersionId: Ulid;
    let created: boolean;
    if (existing) {
      documentVersionId = existing.id;
      created = false;
    } else {
      documentVersionId = ulid(clock.nowMs());
      created = true;
      await db.run(
        `INSERT INTO document_version
           (id, source_id, text, text_hash, word_count, lang, extracted_at,
            producer, producer_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          documentVersionId, args.sourceId, args.text, args.textHash,
          wordCount, args.lang ?? null, clock.now(),
          args.producer, args.producerVersion,
        ],
      );
    }

    await setStatus(db, args.ingestionEventId, 'extracted', null);
    return { documentVersionId, created };
  });
}

/**
 * Record an extraction failure.
 *
 * This is a first-class outcome, not an error path: the user still read the
 * thing, and the attested record of that must not depend on a parser's
 * success. See docs/03-ingestion.md § Extraction.
 */
export async function recordExtractionFailure(
  db: SqlDriver,
  ingestionEventId: Ulid,
  reason: string,
): Promise<void> {
  await setStatus(db, ingestionEventId, 'extraction_failed', reason);
}

export async function setStatus(
  db: SqlDriver,
  ingestionEventId: Ulid,
  status: IngestionStatus,
  reason: string | null,
): Promise<void> {
  await db.run(
    'UPDATE ingestion_event SET status = ?, status_reason = ? WHERE id = ?',
    [status, reason, ingestionEventId],
  );
}

/**
 * Record engagement depth.
 *
 * Never downgrades: if the user annotated a source, a later telemetry-derived
 * `skim` from a quick revisit must not erase that. Depth is the high-water
 * mark of how the user has engaged with this particular encounter.
 */
export async function recordEngagement(
  db: SqlDriver,
  ingestionEventId: Ulid,
  level: Engagement,
  source: EngagementSource,
): Promise<{ applied: boolean }> {
  const { ENGAGEMENT_ORDER } = await import('../types.js');
  const row = await db.get<IngestionEventRow>(
    'SELECT * FROM ingestion_event WHERE id = ?',
    [ingestionEventId],
  );
  if (!row) throw new Error(`no such ingestion event: ${ingestionEventId}`);

  const current = toIngestionEvent(row).engagement;
  if (current) {
    const currentRank = ENGAGEMENT_ORDER.indexOf(current);
    const nextRank = ENGAGEMENT_ORDER.indexOf(level);
    if (nextRank <= currentRank) return { applied: false };
  }

  await db.run(
    'UPDATE ingestion_event SET engagement = ?, engagement_source = ? WHERE id = ?',
    [level, source, ingestionEventId],
  );
  return { applied: true };
}

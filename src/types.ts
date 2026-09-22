/**
 * Domain types for cognis core.
 *
 * The attested/derived split from docs/02-data-model.md is expressed here as
 * separate type groups. Attested records describe what happened; derived
 * records are computed and rebuildable.
 */

/** ISO-8601 UTC timestamp, e.g. "2026-09-22T02:57:57.000Z". */
export type Timestamp = string;

/** ULID. Sortable, offline-generatable, no coordination needed. */
export type Ulid = string;

export type SourceKind = 'web' | 'pdf' | 'paper' | 'epub' | 'note';

export type CapturePath = 'share_sheet' | 'reader' | 'file_import' | 'backfill';

/**
 * Engagement depth, ordered by the processing depth it implies.
 * `apply` and `teach` can only be user-asserted.
 */
export type Engagement = 'skim' | 'read' | 'annotate' | 'apply' | 'teach';

export const ENGAGEMENT_ORDER: readonly Engagement[] = [
  'skim',
  'read',
  'annotate',
  'apply',
  'teach',
];

/**
 * How an engagement level was established. Kept separate from the level so a
 * later model fit can weight telemetry and self-report differently, and so the
 * two are never silently conflated.
 */
export type EngagementSource = 'user_asserted' | 'telemetry' | 'inferred_default';

/**
 * Ingestion state machine. See docs/01-architecture.md § Pipelines.
 * `extraction_failed` is a terminal-but-retryable state, NOT a lost record:
 * the source and the ingestion event survive it.
 */
export type IngestionStatus =
  | 'captured'
  | 'extracted'
  | 'chunked'
  | 'embedded'
  | 'linked'
  | 'rolled_up'
  | 'itemised'
  | 'extraction_failed';

export type AnnotationKind = 'highlight' | 'note';

export type AssertionKind =
  | 'quality'
  | 'not_interested'
  | 'concept_merge'
  | 'concept_split'
  | 'mention_reject'
  | 'mention_add'
  | 'known_already';

export type AssertionSubject = 'source' | 'concept' | 'mention';

export type EgressDestination = 'model_proxy' | 'scholar_graph' | 'sync_relay';

export type EgressPurpose = 'link' | 'itemise' | 'grade' | 'metadata' | 'sync';

// ---------------------------------------------------------------------------
// Attested records — append-only. Corrections are new rows, never overwrites.
// ---------------------------------------------------------------------------

export interface Source {
  id: Ulid;
  kind: SourceKind;
  canonicalUrl: string | null;
  doi: string | null;
  isbn: string | null;
  contentHash: string | null;
  title: string | null;
  authors: string[] | null;
  publishedAt: Timestamp | null;
  firstSeenAt: Timestamp;
  isPrivate: boolean;
}

export interface IngestionEvent {
  id: Ulid;
  sourceId: Ulid;
  occurredAt: Timestamp;
  capturePath: CapturePath;
  engagement: Engagement | null;
  engagementSource: EngagementSource | null;
  novelty: number | null;
  noveltyModelId: string | null;
  status: IngestionStatus;
  statusReason: string | null;
}

export interface ReadingSession {
  id: Ulid;
  ingestionEventId: Ulid;
  startedAt: Timestamp;
  endedAt: Timestamp;
  activeMs: number;
  maxScrollPct: number | null;
  scrollReversals: number | null;
  estWordsVisible: number | null;
}

export interface Annotation {
  id: Ulid;
  documentVersionId: Ulid;
  kind: AnnotationKind;
  startChar: number | null;
  endChar: number | null;
  quotedText: string | null;
  body: string | null;
  createdAt: Timestamp;
}

export interface UserAssertion {
  id: Ulid;
  kind: AssertionKind;
  subjectType: AssertionSubject;
  subjectId: string;
  objectId: string | null;
  value: number | null;
  note: string | null;
  createdAt: Timestamp;
}

export interface EgressEntry {
  id: Ulid;
  occurredAt: Timestamp;
  destination: EgressDestination;
  purpose: EgressPurpose;
  sourceIds: string[];
  bytesSent: number;
  redactions: string | null;
}

// ---------------------------------------------------------------------------
// Derived records — freely deletable and rebuildable from attested data.
// ---------------------------------------------------------------------------

export interface DocumentVersion {
  id: Ulid;
  sourceId: Ulid;
  text: string;
  textHash: string;
  wordCount: number;
  lang: string | null;
  extractedAt: Timestamp;
  producer: string;
  producerVersion: string;
}

/** Stamped onto every derived row. See docs/02-data-model.md § Provenance. */
export interface Provenance {
  producer: string;
  producerVersion: string;
  modelId?: string | null;
  promptVersion?: string | null;
  computedAt: Timestamp;
}

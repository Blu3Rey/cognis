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
import type { Embedder } from './ports/embedder.js';
import { chunkAndEmbed, reembedAll } from './embed/pipeline.js';
import type { ChunkAndEmbedResult, ReembedReport } from './embed/pipeline.js';
import { computeNovelty, recordNovelty } from './embed/novelty.js';
import type { NoveltyResult } from './embed/novelty.js';
import { semanticSearch, literalSearch } from './search/semantic.js';
import type { SearchHit, SearchOptions } from './search/semantic.js';
import type { ChunkOptions } from './chunk/chunker.js';
import type { VocabularyClient } from './ports/vocabulary.js';
import type { Linker } from './ports/linker.js';
import { linkDocument, linkAll, importHierarchy } from './concept/pipeline.js';
import type { LinkOptions, LinkReport } from './concept/pipeline.js';
import { proposeMerges } from './concept/consolidate.js';
import type { MergeProposal, ConsolidateOptions } from './concept/consolidate.js';
import { rollupCoverage, coverageFor } from './coverage/rollup.js';
import type { CoverageRow } from './coverage/rollup.js';
import { uncoveredButRecurring, taxonomy, staleCoverage } from './coverage/queries.js';
import type { ConceptGap, UncoveredOptions, TaxonomyNode } from './coverage/queries.js';
import type { ItemWriter } from './ports/item-writer.js';
import type { Grader } from './ports/grader.js';
import { Scheduler, rebuildMemoryStates } from './retention/scheduler.js';
import type { SchedulerOptions, ReviewRating } from './retention/scheduler.js';
import { generateItems, generateItemsForConcept, retireItem } from './retention/items.js';
import type { GenerateItemsOptions, GenerateItemsReport } from './retention/items.js';
import {
  dueItems, submitReview, overrideGrade, nextDueAt, dueCountOn,
} from './retention/session.js';
import type {
  ReviewCard, SessionOptions, SubmitReviewInput, ReviewResult,
} from './retention/session.js';
import {
  retentionEvidence, calibration, anomalousItems,
} from './retention/evidence.js';
import type { RetentionEvidence, CalibrationReport } from './retention/evidence.js';
import type { ScholarGraph } from './ports/scholar-graph.js';
import { ingestCitations, convergentReferences } from './suggest/citations.js';
import type { CitationIngestReport, ConvergentReference } from './suggest/citations.js';
import {
  buildCooccurrence, conceptClusters, bridgeGaps, taxonomyHoles,
} from './suggest/structural.js';
import type { ConceptCluster, BridgeGap, TaxonomyHole } from './suggest/structural.js';
import {
  generateSuggestions, activeSuggestions, dismissSuggestion,
} from './suggest/rank.js';
import type { Suggestion, GenerateSuggestionsOptions } from './suggest/rank.js';
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
  /**
   * Optional until M1 features are used. Absent means the corpus still
   * captures, exports and deletes — it simply has no vectors, so novelty and
   * semantic search are unavailable and say so rather than returning silence.
   */
  embedder?: Embedder;
  /** Candidate generation. Required for concept linking. */
  vocabulary?: VocabularyClient;
  /** Disambiguation. Required for concept linking. */
  linker?: Linker;
  /** Quiz item generation. Required for M3 features. */
  itemWriter?: ItemWriter;
  /** Answer grading. Required to submit reviews. */
  grader?: Grader;
  /** Scheduler configuration. A default scheduler is always constructed. */
  scheduler?: SchedulerOptions;
  /** Citation graph access. Required to ingest citations. */
  scholarGraph?: ScholarGraph;
}

export class Cognis {
  readonly db: SqlDriver;
  readonly clock: Clock;
  readonly embedder: Embedder | null;
  readonly vocabulary: VocabularyClient | null;
  readonly linker: Linker | null;
  readonly itemWriter: ItemWriter | null;
  readonly grader: Grader | null;
  readonly scheduler: Scheduler;
  readonly scholarGraph: ScholarGraph | null;

  constructor(opts: CognisOptions) {
    this.db = opts.db;
    this.clock = opts.clock ?? systemClock;
    this.embedder = opts.embedder ?? null;
    this.vocabulary = opts.vocabulary ?? null;
    this.linker = opts.linker ?? null;
    this.itemWriter = opts.itemWriter ?? null;
    this.grader = opts.grader ?? null;
    this.scheduler = new Scheduler(opts.scheduler ?? {});
    this.scholarGraph = opts.scholarGraph ?? null;
  }

  #requireItemWriter(feature: string): ItemWriter {
    if (!this.itemWriter) {
      throw new Error(`${feature} needs an itemWriter; construct Cognis with one`);
    }
    return this.itemWriter;
  }

  #requireGrader(feature: string): Grader {
    if (!this.grader) {
      throw new Error(`${feature} needs a grader; construct Cognis with one`);
    }
    return this.grader;
  }

  #requireLinking(feature: string): { vocabulary: VocabularyClient; linker: Linker } {
    if (!this.vocabulary || !this.linker) {
      throw new Error(
        `${feature} needs a vocabulary and a linker; construct Cognis with both`,
      );
    }
    return { vocabulary: this.vocabulary, linker: this.linker };
  }

  #requireEmbedder(feature: string): Embedder {
    if (!this.embedder) {
      throw new Error(
        `${feature} needs an embedder; construct Cognis with { embedder }`,
      );
    }
    return this.embedder;
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

  // -- Chunking, embedding, novelty (M1) -----------------------------------

  /** Chunk and embed a document version. Idempotent; re-running replaces. */
  async chunkAndEmbed(
    documentVersionId: Ulid,
    opts: ChunkOptions = {},
  ): Promise<ChunkAndEmbedResult> {
    return chunkAndEmbed(
      this.db, this.clock, this.#requireEmbedder('chunkAndEmbed'),
      documentVersionId, opts,
    );
  }

  /**
   * Chunk, embed, and record novelty in one step — the share-time path.
   *
   * Novelty is computed before this document's own vectors could match
   * themselves, so the score answers "is this new to me?" rather than "is this
   * identical to itself?".
   */
  async indexDocument(args: {
    documentVersionId: Ulid;
    ingestionEventId: Ulid;
    chunkOptions?: ChunkOptions;
  }): Promise<{ indexed: ChunkAndEmbedResult; novelty: NoveltyResult; noveltyRecorded: boolean }> {
    const embedder = this.#requireEmbedder('indexDocument');
    const indexed = await this.chunkAndEmbed(
      args.documentVersionId, args.chunkOptions ?? {},
    );
    const novelty = await computeNovelty(this.db, embedder, args.documentVersionId);
    const { recorded } = await recordNovelty(this.db, args.ingestionEventId, novelty);
    return { indexed, novelty, noveltyRecorded: recorded };
  }

  async computeNovelty(documentVersionId: Ulid): Promise<NoveltyResult> {
    return computeNovelty(this.db, this.#requireEmbedder('computeNovelty'), documentVersionId);
  }

  /** Re-embed the whole corpus. A scoped rebuild, not a migration. */
  async reembedAll(opts: ChunkOptions = {}): Promise<ReembedReport> {
    return reembedAll(this.db, this.clock, this.#requireEmbedder('reembedAll'), opts);
  }

  // -- Concepts and coverage (M2) ------------------------------------------

  /** Link one document version. Idempotent; re-running is a scoped rebuild. */
  async linkDocument(documentVersionId: Ulid, opts: LinkOptions = {}): Promise<LinkReport> {
    const { vocabulary, linker } = this.#requireLinking('linkDocument');
    return linkDocument(this.db, this.clock, vocabulary, linker, documentVersionId, opts);
  }

  /** Relink the whole corpus. Concept ids do not move; evidence is recomputed. */
  async linkAll(opts: LinkOptions = {}): Promise<LinkReport[]> {
    const { vocabulary, linker } = this.#requireLinking('linkAll');
    return linkAll(this.db, this.clock, vocabulary, linker, opts);
  }

  /** Pull vocabulary hierarchy edges for concepts already in the corpus. */
  async importHierarchy(): Promise<{ edges: number; ancestorsAdded: number }> {
    const { vocabulary } = this.#requireLinking('importHierarchy');
    return importHierarchy(this.db, this.clock, vocabulary);
  }

  /** Recompute the coverage rollup from mentions and attested rows. */
  async rollupCoverage(): Promise<{ concepts: number }> {
    return rollupCoverage(this.db, this.clock);
  }

  async coverageFor(conceptId: string): Promise<CoverageRow | null> {
    return coverageFor(this.db, conceptId);
  }

  /**
   * Concepts met from several sources but never covered directly — the
   * flagship query, and the first question in the success test.
   */
  async uncoveredButRecurring(opts: UncoveredOptions = {}): Promise<ConceptGap[]> {
    return uncoveredButRecurring(this.db, opts);
  }

  async taxonomy(
    opts: { rootConceptId?: string | null; includeUncovered?: boolean } = {},
  ): Promise<TaxonomyNode[]> {
    return taxonomy(this.db, opts);
  }

  async staleCoverage(opts: { before: string; limit?: number }): Promise<ConceptGap[]> {
    return staleCoverage(this.db, opts);
  }

  /** Propose local-concept merges. Only high-confidence ones auto-apply. */
  async proposeMerges(opts: ConsolidateOptions = {}): Promise<MergeProposal[]> {
    return proposeMerges(this.db, this.#requireEmbedder('proposeMerges'), opts);
  }

  /** Record a user correction. Attested, and re-applied after every rebuild. */
  async assert(a: {
    kind: 'quality' | 'not_interested' | 'concept_merge' | 'concept_split'
      | 'mention_reject' | 'mention_add' | 'known_already';
    subjectType: 'source' | 'concept' | 'mention';
    subjectId: string;
    objectId?: string | null;
    value?: number | null;
    note?: string | null;
  }): Promise<{ assertionId: Ulid }> {
    const id = ulid(this.clock.nowMs());
    await this.db.run(
      `INSERT INTO user_assertion
         (id, kind, subject_type, subject_id, object_id, value, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, a.kind, a.subjectType, a.subjectId, a.objectId ?? null,
        a.value ?? null, a.note ?? null, this.clock.now(),
      ],
    );
    return { assertionId: id };
  }

  // -- Retention (M3) ------------------------------------------------------

  /** Generate items for covered concepts that have none. */
  async generateItems(opts: GenerateItemsOptions = {}): Promise<GenerateItemsReport> {
    return generateItems(this.db, this.clock, this.#requireItemWriter('generateItems'), opts);
  }

  async generateItemsForConcept(
    conceptId: string,
    opts: GenerateItemsOptions = {},
  ): Promise<{ generated: number; rejected: { reason: string }[] }> {
    return generateItemsForConcept(
      this.db, this.clock, this.#requireItemWriter('generateItemsForConcept'),
      conceptId, opts,
    );
  }

  async retireItem(itemId: Ulid, reason: string): Promise<void> {
    return retireItem(this.db, this.clock, itemId, reason);
  }

  /** Assemble a review session: budgeted, interleaved, schedule-respecting. */
  async dueItems(opts: SessionOptions = {}): Promise<ReviewCard[]> {
    return dueItems(this.db, this.clock, this.scheduler, opts);
  }

  async submitReview(input: SubmitReviewInput): Promise<ReviewResult> {
    return submitReview(
      this.db, this.clock, this.scheduler, this.#requireGrader('submitReview'), input,
    );
  }

  /** The user disagreeing with the grader is signal, and changes the schedule. */
  async overrideGrade(reviewId: Ulid, rating: ReviewRating): Promise<{ nextDueAt: string }> {
    return overrideGrade(this.db, this.scheduler, reviewId, rating);
  }

  /** When the next review falls due — the input to notification scheduling. */
  async nextDueAt(): Promise<string | null> {
    return nextDueAt(this.db);
  }

  async dueCountOn(day: string): Promise<number> {
    return dueCountOn(this.db, day);
  }

  /**
   * Retention evidence for a concept.
   *
   * When `evidenceSufficient` is false, `modelledRecall` is null and there is
   * nothing for a client to render a score from. The honest-presentation rule
   * lives in the type rather than in a style guide.
   */
  async retentionEvidence(conceptId: string): Promise<RetentionEvidence> {
    return retentionEvidence(this.db, this.clock, this.scheduler, conceptId);
  }

  /** How the model's predictions have actually performed. */
  async calibration(opts: { bins?: number } = {}): Promise<CalibrationReport> {
    return calibration(this.db, this.clock, opts);
  }

  async anomalousItems(opts: { minReviews?: number } = {}) {
    return anomalousItems(this.db, opts);
  }

  /** Recompute memory state from the review log. A rebuild, not a migration. */
  async rebuildMemoryStates(): Promise<{ items: number; reviewsReplayed: number }> {
    return rebuildMemoryStates(this.db, this.clock, this.scheduler);
  }

  // -- Suggestions (M4) ----------------------------------------------------

  /** Fetch reference lists for corpus sources with DOIs. No model calls. */
  async ingestCitations(opts: { limit?: number } = {}): Promise<CitationIngestReport> {
    if (!this.scholarGraph) {
      throw new Error('ingestCitations needs a scholarGraph; construct Cognis with one');
    }
    return ingestCitations(this.db, this.clock, this.scholarGraph, opts);
  }

  /** Works several corpus sources cite that the user has never opened. */
  async convergentReferences(
    opts: { minCiting?: number; limit?: number } = {},
  ): Promise<ConvergentReference[]> {
    return convergentReferences(this.db, opts);
  }

  /** Recompute concept co-occurrence, the input to clustering and bridges. */
  async buildCooccurrence(opts: { minShared?: number } = {}): Promise<{ edges: number }> {
    return buildCooccurrence(this.db, opts);
  }

  async conceptClusters(opts: { minSize?: number } = {}): Promise<ConceptCluster[]> {
    return conceptClusters(this.db, opts);
  }

  async bridgeGaps(
    opts: { minClusterSize?: number; limit?: number } = {},
  ): Promise<BridgeGap[]> {
    return bridgeGaps(this.db, opts);
  }

  async taxonomyHoles(
    opts: { minCoveredSources?: number; limit?: number } = {},
  ): Promise<TaxonomyHole[]> {
    return taxonomyHoles(this.db, opts);
  }

  /**
   * Build a suggestion slate on the coverage frontier.
   *
   * Diversity cap and serendipity slot are enforced here, not left to the
   * client, and the ranking carries no engagement term by design.
   */
  async generateSuggestions(opts: GenerateSuggestionsOptions = {}): Promise<Suggestion[]> {
    // The embedder is passed through so the `neighbour` fallback can run when
    // asked for; it stays unused unless structural signals come up short.
    return generateSuggestions(this.db, this.clock, {
      ...opts,
      ...(opts.embedder || !this.embedder ? {} : { embedder: this.embedder }),
    });
  }

  async suggestions(opts: { limit?: number } = {}): Promise<Suggestion[]> {
    return activeSuggestions(this.db, this.clock, opts);
  }

  async dismissSuggestion(
    id: string,
    reason?: 'not_interested' | 'already_known' | 'not_now',
  ): Promise<void> {
    return dismissSuggestion(this.db, this.clock, id, reason);
  }

  // -- Search --------------------------------------------------------------

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return semanticSearch(this.db, this.#requireEmbedder('search'), query, opts);
  }

  /** Literal substring search. Works with no embedder and no vectors. */
  async searchLiteral(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return literalSearch(this.db, query, opts);
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

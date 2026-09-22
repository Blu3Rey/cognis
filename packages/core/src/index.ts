/** @cognis/core — public surface. */

export { Cognis } from './core.js';
export type { CognisOptions } from './core.js';

export * from './types.js';
export { ulid, ulidTime, isUlid } from './ids.js';

export type { SqlDriver, SqlValue, Clock } from './ports/index.js';
export { systemClock, FakeClock } from './ports/index.js';
export { NodeSqliteDriver } from './adapters/node-sqlite.js';

export { migrate, appliedMigrations, MIGRATIONS } from './db/migrate.js';
export type { Migration, MigrateResult } from './db/migrate.js';

export { canonicaliseUrl, sameDocument } from './canonical/url.js';
export type { CanonicalUrl, CanonicaliseOptions } from './canonical/url.js';
export {
  normaliseDoi, doiUrl, findDoiInText, arxivIdFromUrl, arxivDoi,
} from './canonical/doi.js';
export { sha256, sha256Bytes, textFingerprint } from './canonical/hash.js';

export {
  capture, recordExtraction, recordExtractionFailure, recordEngagement, setStatus,
  resolveIdentity,
} from './capture/capture.js';
export type { CaptureInput, CaptureResult } from './capture/capture.js';
export { priorCoverageFor } from './capture/prior-coverage.js';
export type { PriorCoverage } from './capture/prior-coverage.js';
export { deleteSource } from './capture/delete.js';
export type { DeleteReport } from './capture/delete.js';

export { chunkText, CHUNKER_VERSION } from './chunk/chunker.js';
export type { TextChunk, ChunkOptions } from './chunk/chunker.js';

export type { Embedder } from './ports/embedder.js';
export { HashEmbedder } from './adapters/hash-embedder.js';
export type { HashEmbedderOptions } from './adapters/hash-embedder.js';

export { toBlob, fromBlob, l2Normalise, cosine } from './embed/vectors.js';
export { chunkAndEmbed, reembedAll } from './embed/pipeline.js';
export type { ChunkAndEmbedResult, ReembedReport } from './embed/pipeline.js';
export { computeNovelty, recordNovelty } from './embed/novelty.js';
export type { NoveltyResult } from './embed/novelty.js';
export { putVector, scanVectors, vectorCount } from './embed/store.js';
export type { StoredVector, ScanOptions } from './embed/store.js';

export type {
  VocabularyClient, ConceptCandidate, VocabularyEdge, VocabularyHierarchy,
} from './ports/vocabulary.js';
export type { Linker, LinkRequest, LinkDecision, SpottedMention } from './ports/linker.js';
export { FixtureVocabulary } from './adapters/fixture-vocabulary.js';
export type { FixtureConcept } from './adapters/fixture-vocabulary.js';
export { RuleLinker } from './adapters/rule-linker.js';
export type { RuleLinkerOptions } from './adapters/rule-linker.js';

export { spotMentions, SPOTTER_VERSION } from './concept/spotter.js';
export type { Spot, SpotOptions } from './concept/spotter.js';
export {
  linkDocument, linkAll, importHierarchy, localKeyFor, LINKER_PIPELINE_VERSION,
} from './concept/pipeline.js';
export type { LinkOptions, LinkReport } from './concept/pipeline.js';
export {
  loadOverrides, applyOverrides, resolveConceptId, rejectionKey, pairKey,
} from './concept/overrides.js';
export type { OverrideSet } from './concept/overrides.js';
export { proposeMerges } from './concept/consolidate.js';
export type { MergeProposal, ConsolidateOptions } from './concept/consolidate.js';

export { rollupCoverage, coverageFor, ROLLUP_VERSION } from './coverage/rollup.js';
export type { CoverageRow } from './coverage/rollup.js';
export { uncoveredButRecurring, taxonomy, staleCoverage } from './coverage/queries.js';
export type { ConceptGap, UncoveredOptions, TaxonomyNode } from './coverage/queries.js';

export type {
  ItemWriter, ItemGenerationRequest, GeneratedItem, RubricPoint, EvidenceSpan,
} from './ports/item-writer.js';
export type { Grader, GradeRequest, GradeResult } from './ports/grader.js';
export { TemplateItemWriter } from './adapters/template-item-writer.js';
export type { TemplateItemWriterOptions } from './adapters/template-item-writer.js';
export { KeywordGrader } from './adapters/keyword-grader.js';
export type { KeywordGraderOptions } from './adapters/keyword-grader.js';

export {
  Scheduler, scoreToRating, paramsHash, rebuildMemoryStates, loadMemoryState,
  saveMemoryState, SCHEDULER_NAME, SCHEDULER_VERSION, DEFAULT_THRESHOLDS,
  RATING_AGAIN, RATING_HARD, RATING_GOOD, RATING_EASY,
} from './retention/scheduler.js';
export type {
  ReviewRating, RatingThresholds, SchedulerOptions, MemoryStateRow,
} from './retention/scheduler.js';
export {
  generateItems, generateItemsForConcept, retireItem, validateGroundedness,
  evidenceFor, ITEM_PIPELINE_VERSION,
} from './retention/items.js';
export type {
  GenerateItemsOptions, GenerateItemsReport, GroundednessResult,
} from './retention/items.js';
export {
  dueItems, submitReview, overrideGrade, nextDueAt, dueCountOn,
} from './retention/session.js';
export type {
  ReviewCard, SessionOptions, SubmitReviewInput, ReviewResult,
} from './retention/session.js';
export {
  retentionEvidence, calibration, anomalousItems,
  MIN_REVIEWS_FOR_ESTIMATE, DURABILITY_INTERVAL_DAYS,
} from './retention/evidence.js';
export type {
  RetentionEvidence, CalibrationReport, CalibrationBin,
} from './retention/evidence.js';

export type { ScholarGraph, WorkMetadata } from './ports/scholar-graph.js';
export { FixtureScholarGraph } from './adapters/fixture-scholar-graph.js';
export type { FixtureWork } from './adapters/fixture-scholar-graph.js';

export {
  ingestCitations, convergentReferences, CITATION_PIPELINE_VERSION,
} from './suggest/citations.js';
export type { CitationIngestReport, ConvergentReference } from './suggest/citations.js';
export {
  buildCooccurrence, conceptClusters, bridgeGaps, taxonomyHoles, STRUCTURAL_VERSION,
} from './suggest/structural.js';
export type { ConceptCluster, BridgeGap, TaxonomyHole } from './suggest/structural.js';
export { neighbourCandidates } from './suggest/neighbours.js';
export type { NeighbourCandidate } from './suggest/neighbours.js';
export {
  generateSuggestions, activeSuggestions, dismissSuggestion,
  DEFAULT_WEIGHTS, RANKER_VERSION,
} from './suggest/rank.js';
export type {
  Suggestion, SuggestionKind, SuggestionReason, RankWeights,
  GenerateSuggestionsOptions,
} from './suggest/rank.js';

export {
  recordTelemetry, assessPlausibility, deriveEngagement,
  TELEMETRY_VERSION, READING_WPM, MAX_TIME_MULTIPLE, MIN_READ_FRACTION,
  READ_SCROLL_PCT, MIN_SESSION_MS,
} from './reader/telemetry.js';
export type {
  RawTelemetry, PlausibilityVerdict, RecordTelemetryResult,
} from './reader/telemetry.js';
export {
  DEFAULT_ENGAGEMENT_PRIOR, NEUTRAL_ENGAGEMENT_PRIOR, multiplierFor,
  ENGAGEMENT_PRIOR_VERSION,
} from './reader/engagement-prior.js';
export type { EngagementPrior } from './reader/engagement-prior.js';

export { neighbourhood, MAX_NEIGHBOURHOOD_NODES } from './graph/neighbourhood.js';
export type {
  Neighbourhood, NeighbourhoodOptions, GraphNode, GraphEdge, EdgeProvenance,
} from './graph/neighbourhood.js';

export {
  evaluateEngagementPrior, formatEngagementComparison,
  MIN_REVIEWS_FOR_COMPARISON,
} from './eval/engagement.js';
export type { EngagementComparison, ReplayScore } from './eval/engagement.js';

export type { SyncRelay, RelayBatch } from './ports/sync-relay.js';
export type { KeyDerivation, KdfParams } from './ports/key-derivation.js';
export { MemoryRelay } from './adapters/memory-relay.js';
export {
  SyncCipher, Pbkdf2KeyDerivation, newKeyset, describeRecovery,
  ENVELOPE_VERSION, PBKDF2_ITERATIONS, SALT_BYTES,
} from './sync/crypto.js';
export type { SyncKeyset, Envelope } from './sync/crypto.js';
export { toBase64, fromBase64 } from './sync/base64.js';
export {
  push, pull, saveKeyset, loadKeyset, deviceId, resetPullCursor,
  SYNC_PROTOCOL_VERSION,
} from './sync/sync.js';
export type { SyncPayload, PushReport, PullReport } from './sync/sync.js';
export { mergeRow, SYNCED_TABLES, APPLY_ORDER } from './sync/merge.js';
export type { Row } from './sync/merge.js';

export { classifyUrl } from './privacy/domains.js';
export type { PrivacyClassification } from './privacy/domains.js';
export { redactUrl, redactText } from './privacy/redact.js';
export type { Redaction, RedactionResult } from './privacy/redact.js';
export {
  withEgress, logEgress, readEgressLog, egressSummary, privateSourceIds,
  isSourcePrivate, PrivateSourceError, EXCLUDE_PRIVATE_SQL,
} from './privacy/egress.js';
export type { EgressRequest, EgressEntry } from './privacy/egress.js';

export { timeline, bucket } from './coverage/timeline.js';
export type {
  TimelineRow, TimelineOptions, TimelineEncounter, TimelineReview, Granularity,
} from './coverage/timeline.js';
export { deleteConceptHistory } from './capture/delete-concept.js';
export type { ConceptDeleteReport } from './capture/delete-concept.js';

export { runLinkingEval, identityStability, formatReport } from './eval/linking.js';
export type {
  GoldMention, GoldDocument, LinkingMetrics, LinkingEvalReport,
} from './eval/linking.js';

export { semanticSearch, literalSearch } from './search/semantic.js';
export type { SearchHit, SearchOptions } from './search/semantic.js';

export {
  exportJsonl, exportJsonlString, importJsonl, linesOf,
  assertManifestCoversSchema, EXPORT_FORMAT_VERSION,
} from './export/jsonl.js';
export type { ExportHeader, ExportRow, ImportReport } from './export/jsonl.js';
export { TABLES, ATTESTED_TABLES, REBUILDABLE_TABLES } from './export/tables.js';
export type { TableSpec } from './export/tables.js';

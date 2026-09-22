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
  VocabularyClient, ConceptCandidate, VocabularyEdge,
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

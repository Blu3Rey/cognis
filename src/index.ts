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

export {
  exportJsonl, exportJsonlString, importJsonl, linesOf,
  assertManifestCoversSchema, EXPORT_FORMAT_VERSION,
} from './export/jsonl.js';
export type { ExportHeader, ExportRow, ImportReport } from './export/jsonl.js';
export { TABLES, ATTESTED_TABLES } from './export/tables.js';
export type { TableSpec } from './export/tables.js';

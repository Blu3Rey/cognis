/**
 * Export manifest.
 *
 * One declaration of every table and its columns, shared by export and import
 * so the two cannot drift. Adding a table to the schema without adding it here
 * is caught by `assertManifestCoversSchema`, which the export test runs — an
 * export that silently omits a table is exactly the data loss M0 exists to
 * prevent.
 */

export interface TableSpec {
  name: string;
  columns: readonly string[];
  /** Attested tables are irreplaceable; derived tables are recomputable. */
  attested: boolean;
  /**
   * Whether the table is written to an export.
   *
   * Attested tables are always exported — losing one is unrecoverable. Derived
   * tables are exported only when recomputing them would be expensive or
   * lossy. Chunks and vectors are neither: they are a pure, deterministic
   * function of `document_version` plus the chunker and embedder, and float32
   * vectors would dominate the export's size for data the importing device can
   * regenerate offline in seconds. So they are omitted and rebuilt on import.
   */
  exportable: boolean;
}

export const TABLES: readonly TableSpec[] = [
  {
    name: 'source',
    attested: true,
    exportable: true,
    columns: [
      'id', 'kind', 'canonical_url', 'doi', 'isbn', 'content_hash', 'title',
      'authors_json', 'published_at', 'first_seen_at', 'is_private',
    ],
  },
  {
    name: 'ingestion_event',
    attested: true,
    exportable: true,
    columns: [
      'id', 'source_id', 'occurred_at', 'capture_path', 'engagement',
      'engagement_source', 'novelty', 'novelty_model_id', 'status',
      'status_reason',
    ],
  },
  {
    name: 'document_version',
    attested: false,
    // Derived, but exported: re-extraction needs the original source to still
    // be reachable, and the raw text is what makes re-chunking possible at all.
    exportable: true,
    columns: [
      'id', 'source_id', 'text', 'text_hash', 'word_count', 'lang',
      'extracted_at', 'producer', 'producer_version',
    ],
  },
  {
    name: 'chunk',
    attested: false,
    exportable: false,
    columns: [
      'id', 'document_version_id', 'ordinal', 'start_char', 'end_char', 'text',
      'section_path', 'producer_version',
    ],
  },
  {
    name: 'embedding_meta',
    attested: false,
    exportable: false,
    columns: ['chunk_id', 'model_id', 'dim', 'computed_at'],
  },
  {
    name: 'embedding_vector',
    attested: false,
    exportable: false,
    columns: ['chunk_id', 'model_id', 'vector'],
  },
  {
    name: 'reading_session',
    attested: true,
    exportable: true,
    columns: [
      'id', 'ingestion_event_id', 'started_at', 'ended_at', 'active_ms',
      'max_scroll_pct', 'scroll_reversals', 'est_words_visible',
    ],
  },
  {
    name: 'annotation',
    attested: true,
    exportable: true,
    columns: [
      'id', 'document_version_id', 'kind', 'start_char', 'end_char',
      'quoted_text', 'body', 'created_at',
    ],
  },
  {
    name: 'user_assertion',
    attested: true,
    exportable: true,
    columns: [
      'id', 'kind', 'subject_type', 'subject_id', 'object_id', 'value', 'note',
      'created_at',
    ],
  },
  {
    name: 'egress_log',
    attested: true,
    exportable: true,
    columns: [
      'id', 'occurred_at', 'destination', 'purpose', 'source_ids',
      'bytes_sent', 'redactions',
    ],
  },
];

/**
 * Export order must satisfy foreign keys on import: a table appears only after
 * every table it references. `document_version` before `annotation`, and
 * `ingestion_event` before `reading_session`.
 */
export const EXPORT_ORDER = TABLES.filter((t) => t.exportable);

/** Derived tables omitted from exports, rebuilt by re-running the pipeline. */
export const REBUILDABLE_TABLES = TABLES.filter((t) => !t.exportable).map((t) => t.name);

export const ATTESTED_TABLES = TABLES.filter((t) => t.attested).map((t) => t.name);

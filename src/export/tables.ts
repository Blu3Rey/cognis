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
}

export const TABLES: readonly TableSpec[] = [
  {
    name: 'source',
    attested: true,
    columns: [
      'id', 'kind', 'canonical_url', 'doi', 'isbn', 'content_hash', 'title',
      'authors_json', 'published_at', 'first_seen_at', 'is_private',
    ],
  },
  {
    name: 'ingestion_event',
    attested: true,
    columns: [
      'id', 'source_id', 'occurred_at', 'capture_path', 'engagement',
      'engagement_source', 'novelty', 'novelty_model_id', 'status',
      'status_reason',
    ],
  },
  {
    name: 'document_version',
    attested: false,
    columns: [
      'id', 'source_id', 'text', 'text_hash', 'word_count', 'lang',
      'extracted_at', 'producer', 'producer_version',
    ],
  },
  {
    name: 'reading_session',
    attested: true,
    columns: [
      'id', 'ingestion_event_id', 'started_at', 'ended_at', 'active_ms',
      'max_scroll_pct', 'scroll_reversals', 'est_words_visible',
    ],
  },
  {
    name: 'annotation',
    attested: true,
    columns: [
      'id', 'document_version_id', 'kind', 'start_char', 'end_char',
      'quoted_text', 'body', 'created_at',
    ],
  },
  {
    name: 'user_assertion',
    attested: true,
    columns: [
      'id', 'kind', 'subject_type', 'subject_id', 'object_id', 'value', 'note',
      'created_at',
    ],
  },
  {
    name: 'egress_log',
    attested: true,
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
export const EXPORT_ORDER = TABLES;

export const ATTESTED_TABLES = TABLES.filter((t) => t.attested).map((t) => t.name);

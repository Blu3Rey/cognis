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
  /**
   * Column(s) to sort by on export. Defaults to `id`.
   *
   * Two exports of the same database must be byte-identical, which needs a
   * deterministic order — and not every table is keyed by `id`: the citation
   * graph is keyed by DOI.
   */
  orderBy?: string;
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
    orderBy: 'chunk_id, model_id',
    columns: ['chunk_id', 'model_id', 'dim', 'computed_at'],
  },
  {
    name: 'embedding_vector',
    attested: false,
    exportable: false,
    orderBy: 'chunk_id, model_id',
    columns: ['chunk_id', 'model_id', 'vector'],
  },
  {
    name: 'concept',
    attested: false,
    // Exported despite being derived: concept ids are external and stable, and
    // carrying them means an imported corpus keeps its graph identity even
    // before a relink runs.
    exportable: true,
    columns: [
      'id', 'scheme', 'label', 'description', 'aliases_json', 'resolved_at',
      'promoted_from',
    ],
  },
  {
    name: 'mention',
    attested: false,
    exportable: false,
    columns: [
      'id', 'chunk_id', 'concept_id', 'start_char', 'end_char', 'surface_form',
      'confidence', 'is_primary', 'producer_version', 'model_id', 'prompt_version',
    ],
  },
  {
    name: 'edge',
    attested: false,
    exportable: false,
    columns: [
      'id', 'from_concept', 'to_concept', 'relation', 'provenance', 'weight',
      'producer_version',
    ],
  },
  {
    name: 'coverage',
    attested: false,
    exportable: false,
    orderBy: 'concept_id',
    columns: [
      'concept_id', 'distinct_sources', 'primary_sources', 'first_contact_at',
      'last_contact_at', 'temporal_spread_days', 'max_engagement',
      'contact_count', 'has_user_annotation', 'computed_at', 'producer_version',
    ],
  },
  {
    name: 'reading_session',
    attested: true,
    exportable: true,
    columns: [
      'id', 'ingestion_event_id', 'started_at', 'ended_at', 'active_ms',
      'max_scroll_pct', 'scroll_reversals', 'est_words_visible',
      'plausible', 'implausible_reason', 'capped_active_ms',
      'expected_reading_ms', 'producer_version',
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
    name: 'review',
    attested: true,
    // The graded retrieval outcomes the entire retention model is fit on.
    // Irreplaceable, and the reason memory_state can be derived.
    exportable: true,
    columns: [
      'id', 'quiz_item_id', 'item_prompt_snapshot', 'concept_id', 'presented_at',
      'answered_at', 'latency_ms', 'answer_text', 'self_rating', 'machine_grade',
      'machine_rating', 'grade_rubric_version', 'grade_model_id',
      'user_grade_override', 'scheduled_for', 'predicted_recall', 'interval_days',
    ],
  },
  {
    name: 'quiz_item',
    attested: false,
    // Exported despite being derived: reviews snapshot the prompt, but keeping
    // the items means an imported corpus can carry on reviewing immediately
    // rather than waiting on regeneration through a paid model call.
    exportable: true,
    columns: [
      'id', 'concept_id', 'kind', 'prompt', 'expected_points_json',
      'evidence_json', 'difficulty_hint', 'retired_at', 'retired_reason',
      'producer_version', 'model_id', 'prompt_version', 'computed_at',
    ],
  },
  {
    name: 'memory_state',
    attested: false,
    orderBy: 'scope, scope_id',
    // Recomputable by replaying the review log, which is what makes a
    // scheduler upgrade or parameter refit safe.
    exportable: false,
    columns: [
      'scope', 'scope_id', 'stability', 'difficulty', 'last_review_at',
      'due_at', 'reps', 'lapses', 'state', 'card_json', 'scheduler',
      'scheduler_version', 'params_hash',
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
    name: 'work',
    attested: false,
    orderBy: 'doi',
    // Refetchable from the metadata APIs, but exported anyway: it is small,
    // and carrying it means an imported corpus can produce suggestions
    // immediately rather than re-crawling a few hundred DOIs first.
    exportable: true,
    columns: [
      'doi', 'title', 'authors_json', 'published_year', 'open_access',
      'cited_by_count', 'source_id', 'fetched_at', 'producer_version',
    ],
  },
  {
    name: 'citation',
    attested: false,
    exportable: true,
    orderBy: 'from_doi, to_doi',
    columns: ['from_doi', 'to_doi', 'producer_version'],
  },
  {
    name: 'suggestion',
    attested: false,
    // Ephemeral by design: a slate is a current report, not history. Only
    // dismissals matter across devices, and those are user_assertion rows.
    exportable: false,
    columns: [
      'id', 'kind', 'concept_id', 'external_ref', 'reason_json', 'score',
      'generated_at', 'expires_at', 'dismissed_at', 'dismiss_reason',
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

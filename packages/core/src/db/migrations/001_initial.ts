/**
 * Migration 001 — attested core plus document_version.
 *
 * Covers the M0 slice of docs/02-data-model.md: everything needed to capture,
 * extract, export and delete. The derived graph tables (chunk, embedding,
 * concept, mention, coverage, quiz_item, memory_state, suggestion) arrive with
 * the milestones that use them, so the schema does not carry unused structure
 * that nothing has yet validated.
 */

export const id = '001_initial';

export const up = `
-- ===========================================================================
-- ATTESTED. Append-only. Corrections are new rows, never overwrites.
-- ===========================================================================

CREATE TABLE source (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('web','pdf','paper','epub','note')),
  canonical_url  TEXT,
  doi            TEXT,
  isbn           TEXT,
  content_hash   TEXT,
  title          TEXT,
  authors_json   TEXT,
  published_at   TEXT,
  first_seen_at  TEXT NOT NULL,
  is_private     INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0,1))
);

-- Partial unique indexes rather than table-level UNIQUE: a source may
-- legitimately have no URL (an imported file) or no DOI (most of the web), and
-- SQLite treats every NULL as distinct, so a plain UNIQUE would permit
-- unlimited NULL rows while still blocking the duplicates we care about.
CREATE UNIQUE INDEX source_canonical_url_uq ON source (canonical_url)
  WHERE canonical_url IS NOT NULL;
CREATE UNIQUE INDEX source_doi_uq ON source (doi)
  WHERE doi IS NOT NULL;
CREATE INDEX source_content_hash_idx ON source (content_hash)
  WHERE content_hash IS NOT NULL;

CREATE TABLE ingestion_event (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  occurred_at       TEXT NOT NULL,
  capture_path      TEXT NOT NULL
    CHECK (capture_path IN ('share_sheet','reader','file_import','backfill')),
  engagement        TEXT
    CHECK (engagement IS NULL OR engagement IN ('skim','read','annotate','apply','teach')),
  engagement_source TEXT
    CHECK (engagement_source IS NULL OR
           engagement_source IN ('user_asserted','telemetry','inferred_default')),
  novelty           REAL CHECK (novelty IS NULL OR (novelty >= 0 AND novelty <= 1)),
  novelty_model_id  TEXT,
  status            TEXT NOT NULL
    CHECK (status IN ('captured','extracted','chunked','embedded','linked',
                      'rolled_up','itemised','extraction_failed')),
  status_reason     TEXT,
  -- Novelty is only comparable within one embedding model; a score without
  -- the model that produced it is uninterpretable and silently corrupts
  -- comparisons later.
  CHECK (novelty IS NULL OR novelty_model_id IS NOT NULL)
);
CREATE INDEX ingestion_event_source_idx ON ingestion_event (source_id, occurred_at);
CREATE INDEX ingestion_event_status_idx ON ingestion_event (status);

-- ===========================================================================
-- DERIVED. Deletable and rebuildable from attested rows.
-- ===========================================================================

CREATE TABLE document_version (
  id               TEXT PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  text             TEXT NOT NULL,
  text_hash        TEXT NOT NULL,
  word_count       INTEGER NOT NULL,
  lang             TEXT,
  extracted_at     TEXT NOT NULL,
  producer         TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  UNIQUE (source_id, text_hash)
);
CREATE INDEX document_version_source_idx ON document_version (source_id);
CREATE INDEX document_version_hash_idx ON document_version (text_hash);

-- ===========================================================================
-- ATTESTED, continued. Declared after document_version because annotations
-- anchor to a specific extracted version.
-- ===========================================================================

CREATE TABLE reading_session (
  id                 TEXT PRIMARY KEY,
  ingestion_event_id TEXT NOT NULL REFERENCES ingestion_event(id) ON DELETE CASCADE,
  started_at         TEXT NOT NULL,
  ended_at           TEXT NOT NULL,
  active_ms          INTEGER NOT NULL CHECK (active_ms >= 0),
  max_scroll_pct     REAL,
  scroll_reversals   INTEGER,
  est_words_visible  INTEGER
);
CREATE INDEX reading_session_event_idx ON reading_session (ingestion_event_id);

CREATE TABLE annotation (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('highlight','note')),
  start_char          INTEGER,
  end_char            INTEGER,
  quoted_text         TEXT,
  body                TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX annotation_docver_idx ON annotation (document_version_id);

CREATE TABLE user_assertion (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL
    CHECK (kind IN ('quality','not_interested','concept_merge','concept_split',
                    'mention_reject','mention_add','known_already')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('source','concept','mention')),
  subject_id   TEXT NOT NULL,
  object_id    TEXT,
  value        REAL,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX user_assertion_subject_idx ON user_assertion (subject_type, subject_id);

CREATE TABLE egress_log (
  id          TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('model_proxy','scholar_graph','sync_relay')),
  purpose     TEXT NOT NULL CHECK (purpose IN ('link','itemise','grade','metadata','sync')),
  source_ids  TEXT NOT NULL,
  bytes_sent  INTEGER NOT NULL CHECK (bytes_sent >= 0),
  redactions  TEXT
);
CREATE INDEX egress_log_time_idx ON egress_log (occurred_at);
`;

# 02 — Data Model

The schema is the enforcement mechanism for the project's central invariant. Two
record classes, kept in separate table groups, with different rules.

## The split

| | **Attested** | **Derived** |
|---|---|---|
| Means | This happened | This was computed |
| Written by | User action, device telemetry | Pipelines |
| Mutability | Append-only; corrections are new rows | Freely deletable and rebuildable |
| On model change | Untouched | Recomputed |
| Loss | Unrecoverable | An inconvenience |
| Backup priority | Absolute | None (recomputable) |

**The test:** if a derived table cannot be dropped entirely and rebuilt from
attested tables plus external data, it is misclassified and the schema is wrong.

Two subtleties that are easy to get wrong:

- **Quiz outcomes are attested even though quiz items are derived.** A `review`
  therefore stores a *snapshot* of the prompt text and the targeted concept
  alongside the item id, so regenerating items never orphans the review history.
  This denormalisation is deliberate and required.
- **User corrections to derived data are attested.** When the user merges two
  concepts or rejects a link, that judgment is a first-class attested row and is
  re-applied as an override layer after every rebuild. A rebuild that discards
  user corrections is a data-loss bug.

## Provenance

Every derived table carries:

| Column | Meaning |
|---|---|
| `producer` | pipeline stage name, e.g. `linker` |
| `producer_version` | semver of the stage's logic |
| `model_id` | exact model string, where a model was involved |
| `prompt_version` | hash or semver of the prompt template |
| `computed_at` | timestamp |

Rebuilds are scoped deletes on `(producer, producer_version)`. This is what makes
model churn survivable rather than a migration crisis.

## Schema

SQLite dialect. `id` columns are ULIDs (sortable, offline-generatable, no
coordination) stored as TEXT. Timestamps are ISO-8601 UTC TEXT.

### Attested

```sql
-- A retrievable thing in the world. Identity is external and stable.
CREATE TABLE source (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,        -- 'web' | 'pdf' | 'paper' | 'epub' | 'note'
  canonical_url     TEXT,                 -- normalised: tracking params stripped
  doi               TEXT,
  isbn              TEXT,
  content_hash      TEXT,                 -- sha256 of original bytes, when held
  title             TEXT,                 -- from metadata, never model-authored
  authors_json      TEXT,
  published_at      TEXT,
  first_seen_at     TEXT NOT NULL,
  UNIQUE (canonical_url),
  UNIQUE (doi)
);
CREATE INDEX source_content_hash_idx ON source (content_hash);

-- The user met this source at this time by this route. The core attested fact.
-- Multiple events per source: re-reading is the signal, not a duplicate.
CREATE TABLE ingestion_event (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  occurred_at       TEXT NOT NULL,
  capture_path      TEXT NOT NULL,        -- 'share_sheet' | 'reader' | 'file_import' | 'backfill'
  engagement        TEXT,                 -- 'skim'|'read'|'annotate'|'apply'|'teach' (see 03)
  engagement_source TEXT,                 -- 'user_asserted' | 'telemetry' | 'inferred_default'
  novelty           REAL,                 -- 1 - max cosine sim vs corpus at ingest time
  novelty_model_id  TEXT,                 -- novelty is only comparable within one embedder
  status            TEXT NOT NULL,        -- 'captured'|'extracted'|...|'extraction_failed'
  status_reason     TEXT
);
CREATE INDEX ingestion_event_source_idx ON ingestion_event (source_id, occurred_at);

-- Reader telemetry. Optional; only the built-in reader produces it.
CREATE TABLE reading_session (
  id                  TEXT PRIMARY KEY,
  ingestion_event_id  TEXT NOT NULL REFERENCES ingestion_event(id) ON DELETE CASCADE,
  started_at          TEXT NOT NULL,
  ended_at            TEXT NOT NULL,
  active_ms           INTEGER NOT NULL,   -- foreground, screen-on, excluding idle gaps
  max_scroll_pct      REAL,
  scroll_reversals    INTEGER,            -- re-reading is a depth signal
  est_words_visible   INTEGER
);

-- User-authored content. The only text in the corpus a human wrote.
CREATE TABLE annotation (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,      -- 'highlight' | 'note'
  start_char          INTEGER,
  end_char            INTEGER,
  quoted_text         TEXT,               -- resolved snapshot; anchors can drift
  body                TEXT,               -- user's own words, for kind='note'
  created_at          TEXT NOT NULL
);

-- A graded retrieval attempt. The input the retention model is actually fit on.
CREATE TABLE review (
  id                  TEXT PRIMARY KEY,
  quiz_item_id        TEXT,               -- NOT a FK: items are derived and may be rebuilt
  item_prompt_snapshot TEXT NOT NULL,     -- what was actually asked
  concept_id          TEXT NOT NULL,      -- target, snapshotted
  presented_at        TEXT NOT NULL,
  answered_at         TEXT,
  latency_ms          INTEGER,
  answer_text         TEXT,               -- the user's raw words, never overwritten
  self_rating         INTEGER,            -- 1-4, user's own sense, optional
  machine_grade       REAL,               -- 0..1 from the grader
  machine_rating      INTEGER,            -- 1-4 after threshold mapping
  grade_rubric_version TEXT,
  grade_model_id      TEXT,
  user_grade_override INTEGER,            -- user disagreeing with the grader is data
  scheduled_for       TEXT,               -- what the scheduler intended (for calibration)
  predicted_recall    REAL                -- model's prediction at presentation time
);
CREATE INDEX review_concept_idx ON review (concept_id, presented_at);

-- Explicit user judgments, including corrections to derived data.
CREATE TABLE user_assertion (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,   -- 'quality'|'not_interested'|'concept_merge'
                                -- |'concept_split'|'mention_reject'|'mention_add'|'known_already'
  subject_type TEXT NOT NULL,   -- 'source'|'concept'|'mention'
  subject_id   TEXT NOT NULL,
  object_id    TEXT,            -- e.g. the other concept in a merge
  value        REAL,            -- e.g. quality 1..5
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX user_assertion_subject_idx ON user_assertion (subject_type, subject_id);

-- Every packet of content that left the device. Attested because the user has a
-- right to an accurate record of what was sent where. See docs/09.
CREATE TABLE egress_log (
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL,
  destination   TEXT NOT NULL,   -- 'model_proxy' | 'scholar_graph' | 'sync_relay'
  purpose       TEXT NOT NULL,   -- 'link' | 'itemise' | 'grade' | 'metadata' | 'sync'
  source_ids    TEXT NOT NULL,   -- JSON array
  bytes_sent    INTEGER NOT NULL,
  redactions    TEXT             -- JSON: what was stripped before sending
);
```

### Derived

```sql
-- Extracted text at a point in time. Sources change; versions accumulate.
CREATE TABLE document_version (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  text_hash         TEXT NOT NULL,
  word_count        INTEGER NOT NULL,
  lang              TEXT,
  extracted_at      TEXT NOT NULL,
  producer          TEXT NOT NULL,
  producer_version  TEXT NOT NULL,
  UNIQUE (source_id, text_hash)
);

CREATE TABLE chunk (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  start_char          INTEGER NOT NULL,
  end_char            INTEGER NOT NULL,
  text                TEXT NOT NULL,
  section_path        TEXT,               -- e.g. "3. Methods > 3.2 Sampling"
  producer_version    TEXT NOT NULL,
  UNIQUE (document_version_id, ordinal)
);

-- Vector storage is split in two so the device and the portable build differ
-- in one table rather than in the schema: `embedding_meta` is the metadata
-- side, and the vectors themselves live in `embedding_vector` (a float32 blob)
-- or, on device, in a sqlite-vec virtual table keyed by chunk id. A re-embed
-- is a scoped delete by model_id either way.
CREATE TABLE embedding_meta (
  chunk_id     TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  model_id     TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model_id)
);

CREATE TABLE embedding_vector (
  chunk_id TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  vector   BLOB NOT NULL,          -- little-endian float32
  PRIMARY KEY (chunk_id, model_id)
);

-- A concept node. Identity is EXTERNAL wherever possible. See docs/04.
CREATE TABLE concept (
  id            TEXT PRIMARY KEY,      -- 'wd:Q42' | 'mesh:D000818' | 'local:<ulid>'
  scheme        TEXT NOT NULL,         -- 'wikidata'|'mesh'|'openalex'|'acm_ccs'|'local'
  label         TEXT NOT NULL,         -- from the vocabulary, or user-supplied for local
  description   TEXT,                  -- from the vocabulary; never model-authored
  aliases_json  TEXT,
  resolved_at   TEXT,
  promoted_from TEXT                   -- a local: id that was later anchored externally
);

-- The join that carries the evidence. The most important derived table.
CREATE TABLE mention (
  id               TEXT PRIMARY KEY,
  chunk_id         TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  concept_id       TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  start_char       INTEGER NOT NULL,   -- absolute in document_version
  end_char         INTEGER NOT NULL,
  surface_form     TEXT NOT NULL,
  confidence       REAL NOT NULL,
  is_primary       BOOLEAN NOT NULL,   -- is this source ABOUT the concept?
  producer_version TEXT NOT NULL,
  model_id         TEXT,
  prompt_version   TEXT
);
CREATE INDEX mention_concept_idx ON mention (concept_id);
CREATE INDEX mention_chunk_idx    ON mention (chunk_id);

-- Concept-to-concept relations, distinguished by where they came from.
CREATE TABLE edge (
  id           TEXT PRIMARY KEY,
  from_concept TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  to_concept   TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL,   -- 'subclass_of'|'part_of'|'cites'|'co_occurs'|'user_linked'
  provenance   TEXT NOT NULL,   -- 'vocabulary'|'citation_graph'|'corpus_stats'|'user'
  weight       REAL,
  producer_version TEXT NOT NULL,
  UNIQUE (from_concept, to_concept, relation, provenance)
);

-- Materialised coverage rollup. Pure function of attested data + mentions.
CREATE TABLE coverage (
  concept_id          TEXT PRIMARY KEY REFERENCES concept(id) ON DELETE CASCADE,
  distinct_sources    INTEGER NOT NULL,
  primary_sources     INTEGER NOT NULL,   -- sources ABOUT it, not merely mentioning
  first_contact_at    TEXT,
  last_contact_at     TEXT,
  temporal_spread_days INTEGER,
  max_engagement      TEXT,               -- deepest engagement ever reached
  contact_count       INTEGER NOT NULL,
  has_user_annotation BOOLEAN NOT NULL,
  computed_at         TEXT NOT NULL,
  producer_version    TEXT NOT NULL
);

-- Generated retrieval prompts, bound to the spans that justify them.
CREATE TABLE quiz_item (
  id                  TEXT PRIMARY KEY,
  concept_id          TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,   -- 'free_recall'|'cloze'|'application'|'synthesis'
  prompt              TEXT NOT NULL,
  expected_points_json TEXT NOT NULL,  -- rubric points, each with a citation
  evidence_json       TEXT NOT NULL,   -- [{source_id, document_version_id, start, end}]
  difficulty_hint     REAL,
  retired_at          TEXT,            -- soft-retire rather than delete: reviews reference it
  producer_version    TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,
  computed_at         TEXT NOT NULL
);
CREATE INDEX quiz_item_concept_idx ON quiz_item (concept_id) WHERE retired_at IS NULL;

-- Scheduler state. Derived: refit from the review log at any time.
CREATE TABLE memory_state (
  scope            TEXT NOT NULL,       -- 'item' | 'concept'
  scope_id         TEXT NOT NULL,
  stability        REAL NOT NULL,
  difficulty       REAL NOT NULL,
  last_review_at   TEXT,
  due_at           TEXT NOT NULL,
  reps             INTEGER NOT NULL,
  lapses           INTEGER NOT NULL,
  scheduler        TEXT NOT NULL,       -- implementation name
  scheduler_version TEXT NOT NULL,
  params_hash      TEXT NOT NULL,       -- which parameter vector produced this
  PRIMARY KEY (scope, scope_id)
);
CREATE INDEX memory_state_due_idx ON memory_state (due_at) WHERE scope = 'item';

-- Ephemeral by design. Never accumulates into a recommendation history.
CREATE TABLE suggestion (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,    -- 'citation_gap'|'coverage_gap'|'bridge'|'neighbour'
  concept_id     TEXT REFERENCES concept(id) ON DELETE CASCADE,
  external_ref   TEXT,             -- DOI/URL of the suggested material
  reason_json    TEXT NOT NULL,    -- STRUCTURED evidence, not prose. See docs/06.
  score          REAL NOT NULL,
  generated_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  dismissed_at   TEXT
);
```

## Why some obvious things are not here

**No `summary` column anywhere.** A stored summary is generated knowledge that
would inevitably be read in place of the source. Where a preview is needed, use
the source's own first sentences or a user highlight.

**No `tags` table.** Tags are a hand-maintained, drifting, private vocabulary —
exactly the thing external concept anchoring exists to replace. Annotations
carry user intent; `user_assertion` carries user judgment.

**No global `score` on concepts.** Coverage is a vector of facts, not a number.
Any single-number collapse happens at the presentation layer, where it can be
shown with its inputs, and never gets persisted to be mistaken for truth later.

## Rebuild semantics

```
rebuild(stage, from_version) :=
  BEGIN
    DELETE FROM <stage tables> WHERE producer_version = from_version;
    recompute from attested + upstream derived;
    re-apply user_assertion overrides;       -- mandatory, never optional
    recompute downstream stages;
  COMMIT
```

The override re-application step is the one most likely to be forgotten and the
one whose absence users notice most painfully: a rebuild that silently un-merges
concepts the user merged by hand teaches them never to correct anything again.

## What is exported

Attested tables are always exported: losing one is unrecoverable. Derived
tables are exported only when recomputing them would be expensive or lossy.

| Table | Exported | Why |
|---|---|---|
| all attested tables | yes | irreplaceable |
| `document_version` | yes | re-extraction needs the source to still be reachable, and the raw text is what makes re-chunking possible |
| `chunk`, `embedding_meta`, `embedding_vector` | **no** | a deterministic function of `document_version` plus the chunker and embedder; float32 vectors would dominate the export's size for data the importing device regenerates offline in seconds |

An import therefore lands with no chunks and no vectors, and the importing
device rebuilds them. That is the attested/derived split doing its job, and the
round-trip test asserts it explicitly rather than treating the absence as loss.

## Retention of the raw

Keep `document_version.text` permanently, even after embedding. It is the only
thing that makes re-embedding with a future model possible, and text is small.
Original bytes (PDFs) are kept when the user imported a file; web pages are not
archived by default — that is a separate opt-in feature with different storage
and copyright characteristics.

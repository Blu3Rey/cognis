/**
 * Migration 003 — concepts, mentions, edges, coverage.
 *
 * Concept ids are EXTERNAL wherever possible (`wd:Q…`, `mesh:D…`), so a relink
 * with a different model changes the evidence and never the node identity.
 * See docs/adr/0005-external-concept-vocabulary.md.
 *
 * All four tables are derived. Concept identity being external is exactly what
 * makes that safe: dropping and recomputing mentions does not move the graph.
 */

export const id = '003_concepts';

export const up = `
CREATE TABLE concept (
  id            TEXT PRIMARY KEY,   -- 'wd:Q42' | 'mesh:D000818' | 'local:<ulid>'
  scheme        TEXT NOT NULL
    CHECK (scheme IN ('wikidata','mesh','openalex','acm_ccs','local')),
  label         TEXT NOT NULL,
  description   TEXT,
  aliases_json  TEXT,
  resolved_at   TEXT,
  promoted_from TEXT,
  -- A local concept that was later anchored externally keeps a pointer to its
  -- old id so mentions and user assertions can be followed forward.
  CHECK (scheme <> 'local' OR id LIKE 'local:%')
);
CREATE INDEX concept_scheme_idx ON concept (scheme);
CREATE INDEX concept_label_idx ON concept (label);

CREATE TABLE mention (
  id               TEXT PRIMARY KEY,
  chunk_id         TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  concept_id       TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  start_char       INTEGER NOT NULL,
  end_char         INTEGER NOT NULL,
  surface_form     TEXT NOT NULL,
  confidence       REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- Is the source ABOUT this concept, or does it merely mention it? Without
  -- this, a passing reference counts the same as a chapter on the subject and
  -- every coverage number becomes noise.
  is_primary       INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  producer_version TEXT NOT NULL,
  model_id         TEXT,
  prompt_version   TEXT,
  CHECK (end_char > start_char)
);
CREATE INDEX mention_concept_idx ON mention (concept_id);
CREATE INDEX mention_chunk_idx   ON mention (chunk_id);
CREATE UNIQUE INDEX mention_span_uq
  ON mention (chunk_id, concept_id, start_char, end_char);

CREATE TABLE edge (
  id               TEXT PRIMARY KEY,
  from_concept     TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  to_concept       TEXT NOT NULL REFERENCES concept(id) ON DELETE CASCADE,
  relation         TEXT NOT NULL
    CHECK (relation IN ('subclass_of','part_of','cites','co_occurs','user_linked')),
  -- "Wikidata says this is a subclass" and "these co-occurred in your reading"
  -- are different claims and must never be rendered alike.
  provenance       TEXT NOT NULL
    CHECK (provenance IN ('vocabulary','citation_graph','corpus_stats','user')),
  weight           REAL,
  producer_version TEXT NOT NULL,
  UNIQUE (from_concept, to_concept, relation, provenance)
);
CREATE INDEX edge_from_idx ON edge (from_concept, relation);
CREATE INDEX edge_to_idx   ON edge (to_concept, relation);

CREATE TABLE coverage (
  concept_id           TEXT PRIMARY KEY REFERENCES concept(id) ON DELETE CASCADE,
  distinct_sources     INTEGER NOT NULL,
  primary_sources      INTEGER NOT NULL,
  first_contact_at     TEXT,
  last_contact_at      TEXT,
  temporal_spread_days INTEGER NOT NULL DEFAULT 0,
  max_engagement       TEXT,
  contact_count        INTEGER NOT NULL,
  has_user_annotation  INTEGER NOT NULL CHECK (has_user_annotation IN (0,1)),
  computed_at          TEXT NOT NULL,
  producer_version     TEXT NOT NULL
);
CREATE INDEX coverage_gap_idx ON coverage (primary_sources, distinct_sources);
`;

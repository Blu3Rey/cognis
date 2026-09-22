/**
 * Migration 005 — scholarly works, citations, suggestions.
 *
 * `work` and `citation` hold the citation graph: statements made by domain
 * experts about which work builds on which, requiring zero model calls. They
 * are derived — refetchable from the metadata APIs — but they are the
 * strongest adjacency signal the system has (docs/06-suggestion-engine.md).
 *
 * Citations are between WORKS, identified by DOI, not between concepts. A
 * corpus source with a DOI is also a work; a work with no source is something
 * the user has not read, which is precisely what makes it suggestible.
 */

export const id = '005_suggestions';

export const up = `
CREATE TABLE work (
  doi              TEXT PRIMARY KEY,
  title            TEXT,
  authors_json     TEXT,
  published_year   INTEGER,
  -- Reachability matters more than it sounds: an unobtainable paywalled
  -- monograph is a bad suggestion however well-connected it is.
  open_access      INTEGER NOT NULL DEFAULT 0 CHECK (open_access IN (0,1)),
  cited_by_count   INTEGER,
  -- Set when the user holds this work in their corpus.
  source_id        TEXT REFERENCES source(id) ON DELETE SET NULL,
  fetched_at       TEXT,
  producer_version TEXT NOT NULL
);
CREATE INDEX work_source_idx ON work (source_id);

CREATE TABLE citation (
  from_doi         TEXT NOT NULL,
  to_doi           TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  PRIMARY KEY (from_doi, to_doi),
  CHECK (from_doi <> to_doi)
);
CREATE INDEX citation_to_idx ON citation (to_doi);

CREATE TABLE suggestion (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL
    CHECK (kind IN ('citation_gap','coverage_gap','bridge','taxonomy_hole','neighbour')),
  concept_id   TEXT REFERENCES concept(id) ON DELETE CASCADE,
  external_ref TEXT,
  -- STRUCTURED evidence, never prose. The client renders the sentence; a
  -- model-written reason would be unverifiable and would violate the
  -- generation boundary.
  reason_json  TEXT NOT NULL,
  score        REAL NOT NULL,
  generated_at TEXT NOT NULL,
  -- Suggestions expire. There is no accumulating recommendation history and
  -- no engagement-optimised feed, because there is no engagement objective.
  expires_at   TEXT NOT NULL,
  dismissed_at TEXT,
  dismiss_reason TEXT
);
CREATE INDEX suggestion_active_idx ON suggestion (expires_at) WHERE dismissed_at IS NULL;
CREATE INDEX suggestion_concept_idx ON suggestion (concept_id);
`;

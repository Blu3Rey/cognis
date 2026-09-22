/**
 * Migration 002 — chunks and embeddings.
 *
 * Both tables are derived: droppable and rebuildable from `document_version`
 * plus the embedder. That is what makes re-chunking and re-embedding scoped
 * rebuilds rather than migrations.
 *
 * On the vector side, `embedding_meta` matches docs/02-data-model.md and
 * `embedding_vector` holds the raw float32 blob. A device build substitutes a
 * sqlite-vec virtual table for `embedding_vector` and keeps the metadata table
 * unchanged, which is why the two are separate.
 */

export const id = '002_chunks_embeddings';

export const up = `
CREATE TABLE chunk (
  id                  TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  start_char          INTEGER NOT NULL,
  end_char            INTEGER NOT NULL,
  text                TEXT NOT NULL,
  section_path        TEXT,
  producer_version    TEXT NOT NULL,
  UNIQUE (document_version_id, ordinal),
  CHECK (end_char > start_char)
);
CREATE INDEX chunk_docver_idx ON chunk (document_version_id);

CREATE TABLE embedding_meta (
  chunk_id    TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  dim         INTEGER NOT NULL CHECK (dim > 0),
  computed_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, model_id)
);
CREATE INDEX embedding_meta_model_idx ON embedding_meta (model_id);

CREATE TABLE embedding_vector (
  chunk_id TEXT NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  vector   BLOB NOT NULL,
  PRIMARY KEY (chunk_id, model_id)
);
CREATE INDEX embedding_vector_model_idx ON embedding_vector (model_id);
`;

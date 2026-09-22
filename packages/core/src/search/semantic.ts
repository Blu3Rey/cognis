/**
 * Semantic and literal search over the corpus.
 *
 * Offline, on-device, no model call beyond embedding the query. The brute-force
 * scan is bounded in memory and is honest about its limits: it is linear in
 * corpus size, and a device build swaps in a sqlite-vec ANN index behind the
 * same signature once a corpus is large enough to need one.
 */

import type { SqlDriver } from '../ports/sql.js';
import type { Embedder } from '../ports/embedder.js';
import { cosine } from '../embed/vectors.js';
import { scanVectors } from '../embed/store.js';

export interface SearchHit {
  chunkId: string;
  documentVersionId: string;
  sourceId: string;
  sourceTitle: string | null;
  canonicalUrl: string | null;
  sectionPath: string | null;
  startChar: number;
  endChar: number;
  text: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** Hits below this similarity are dropped. */
  minScore?: number;
}

/** Keep the top-k by score without sorting the whole corpus. */
class TopK {
  #items: { chunkId: string; score: number }[] = [];
  constructor(private readonly k: number) {}

  offer(chunkId: string, score: number): void {
    if (this.#items.length < this.k) {
      this.#items.push({ chunkId, score });
      if (this.#items.length === this.k) this.#items.sort((a, b) => a.score - b.score);
      return;
    }
    const worst = this.#items[0]!;
    if (score <= worst.score) return;
    this.#items[0] = { chunkId, score };
    this.#items.sort((a, b) => a.score - b.score);
  }

  result(): { chunkId: string; score: number }[] {
    return [...this.#items].sort((a, b) => b.score - a.score);
  }
}

export async function semanticSearch(
  db: SqlDriver,
  embedder: Embedder,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0;

  const [queryVector] = await embedder.embed([query]);
  if (!queryVector) throw new Error('embedder returned no vector for the query');

  const top = new TopK(limit);
  for await (const batch of scanVectors(db, {
    modelId: embedder.modelId,
    dim: embedder.dim,
  })) {
    for (const v of batch) {
      const score = cosine(queryVector, v.vector);
      if (score >= minScore) top.offer(v.chunkId, score);
    }
  }

  const ranked = top.result();
  if (ranked.length === 0) return [];

  const byId = new Map(ranked.map((r) => [r.chunkId, r.score]));
  const placeholders = ranked.map(() => '?').join(', ');
  const rows = await db.all<{
    chunk_id: string; document_version_id: string; source_id: string;
    title: string | null; canonical_url: string | null;
    section_path: string | null; start_char: number; end_char: number; text: string;
  }>(
    `SELECT c.id AS chunk_id, c.document_version_id, dv.source_id,
            s.title, s.canonical_url, c.section_path, c.start_char,
            c.end_char, c.text
       FROM chunk c
       JOIN document_version dv ON dv.id = c.document_version_id
       JOIN source s ON s.id = dv.source_id
      WHERE c.id IN (${placeholders})`,
    ranked.map((r) => r.chunkId),
  );

  return rows
    .map((r) => ({
      chunkId: r.chunk_id,
      documentVersionId: r.document_version_id,
      sourceId: r.source_id,
      sourceTitle: r.title,
      canonicalUrl: r.canonical_url,
      sectionPath: r.section_path,
      startChar: r.start_char,
      endChar: r.end_char,
      text: r.text,
      score: byId.get(r.chunk_id) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Literal substring search. Always available, even before anything is embedded. */
export async function literalSearch(
  db: SqlDriver,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const rows = await db.all<{
    chunk_id: string; document_version_id: string; source_id: string;
    title: string | null; canonical_url: string | null;
    section_path: string | null; start_char: number; end_char: number; text: string;
  }>(
    `SELECT c.id AS chunk_id, c.document_version_id, dv.source_id,
            s.title, s.canonical_url, c.section_path, c.start_char,
            c.end_char, c.text
       FROM chunk c
       JOIN document_version dv ON dv.id = c.document_version_id
       JOIN source s ON s.id = dv.source_id
      WHERE c.text LIKE ? ESCAPE '\\'
      ORDER BY c.id
      LIMIT ?`,
    [`%${query.replace(/[\\%_]/g, (m) => '\\' + m)}%`, limit],
  );

  return rows.map((r) => ({
    chunkId: r.chunk_id,
    documentVersionId: r.document_version_id,
    sourceId: r.source_id,
    sourceTitle: r.title,
    canonicalUrl: r.canonical_url,
    sectionPath: r.section_path,
    startChar: r.start_char,
    endChar: r.end_char,
    text: r.text,
    score: 1,
  }));
}

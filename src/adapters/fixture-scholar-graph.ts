/**
 * In-memory scholarly graph — development and tests.
 *
 * Production uses Crossref / OpenAlex / Semantic Scholar through the backend
 * proxy. The shape is the same: metadata plus a reference list, no model.
 */

import type { ScholarGraph, WorkMetadata } from '../ports/scholar-graph.js';

export interface FixtureWork extends WorkMetadata {
  references?: string[];
}

export class FixtureScholarGraph implements ScholarGraph {
  #works = new Map<string, FixtureWork>();

  constructor(works: readonly FixtureWork[]) {
    for (const w of works) this.#works.set(w.doi.toLowerCase(), w);
  }

  async metadata(doi: string): Promise<WorkMetadata | null> {
    const w = this.#works.get(doi.toLowerCase());
    if (!w) return null;
    const { references: _refs, ...meta } = w;
    return meta;
  }

  async references(doi: string): Promise<string[]> {
    return this.#works.get(doi.toLowerCase())?.references ?? [];
  }

  async citedBy(doi: string, limit: number): Promise<string[]> {
    const target = doi.toLowerCase();
    const out: string[] = [];
    for (const w of this.#works.values()) {
      if (w.references?.some((r) => r.toLowerCase() === target)) out.push(w.doi);
      if (out.length >= limit) break;
    }
    return out;
  }
}

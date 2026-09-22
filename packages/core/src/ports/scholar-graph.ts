/**
 * Scholarly graph port.
 *
 * Backed by Crossref / OpenAlex / Semantic Scholar in production, proxied
 * through the backend so lookups are pooled, cached and polite. No model is
 * involved: a reference list is ground truth, not a guess, which is why this
 * is the highest-priority suggestion signal and also the cheapest to run.
 */

export interface WorkMetadata {
  doi: string;
  title: string | null;
  authors: string[];
  publishedYear: number | null;
  openAccess: boolean;
  citedByCount: number | null;
}

export interface ScholarGraph {
  /** Metadata for a work. Null when the DOI is not resolvable. */
  metadata(doi: string): Promise<WorkMetadata | null>;
  /** DOIs this work cites. */
  references(doi: string): Promise<string[]>;
  /** DOIs citing this work. Optional; may be expensive or unavailable. */
  citedBy?(doi: string, limit: number): Promise<string[]>;
}

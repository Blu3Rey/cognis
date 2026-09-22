/**
 * Linker port — disambiguation.
 *
 * The model's job is choosing among retrieved candidates, never naming
 * concepts. That distinction is the whole architectural bet: a choice among a
 * finite set has a correct answer, so precision and recall are measurable and
 * a regression is catchable (docs/adr/0005).
 */

import type { ConceptCandidate } from './vocabulary.js';

export interface SpottedMention {
  surfaceForm: string;
  /** Absolute offsets into the document version's text. */
  startChar: number;
  endChar: number;
  candidates: ConceptCandidate[];
}

export interface LinkRequest {
  chunkId: string;
  chunkText: string;
  sectionPath: string | null;
  documentTitle: string | null;
  mentions: SpottedMention[];
}

export interface LinkDecision {
  surfaceForm: string;
  startChar: number;
  endChar: number;
  /** Chosen candidate id, or null for NIL (no external anchor fits). */
  conceptId: string | null;
  confidence: number;
  /** Is the source ABOUT this concept, or merely mentioning it? */
  isPrimary: boolean;
}

export interface Linker {
  readonly modelId: string;
  readonly promptVersion: string;
  disambiguate(req: LinkRequest): Promise<LinkDecision[]>;
}

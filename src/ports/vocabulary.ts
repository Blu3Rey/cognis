/**
 * Vocabulary port — external concept candidate generation.
 *
 * This is a plain lookup against a public vocabulary (Wikidata, MeSH,
 * OpenAlex), not a model call. Keeping it as its own port matters because the
 * candidate set is what turns linking from open-ended naming into a bounded,
 * measurable classification task (docs/04-concept-identity.md).
 */

export interface ConceptCandidate {
  /** Prefixed external id, e.g. "wd:Q189302". */
  id: string;
  scheme: 'wikidata' | 'mesh' | 'openalex' | 'acm_ccs';
  label: string;
  description: string | null;
  aliases: string[];
}

export interface VocabularyEdge {
  from: string;
  to: string;
  relation: 'subclass_of' | 'part_of';
}

/**
 * A hierarchy is nodes plus edges, not edges alone.
 *
 * Ancestors the user has never read about still have to exist for a tree to
 * render, and they are exactly the "taxonomy holes" the view is meant to show
 * (docs/07-graph-views.md § View 2). Returning them here means the pipeline
 * never has to invent a label for a node it did not retrieve.
 */
export interface VocabularyHierarchy {
  edges: VocabularyEdge[];
  /** Every concept referenced by an edge, including ancestors. */
  concepts: ConceptCandidate[];
}

export interface VocabularyClient {
  /** Candidates for a surface form, best first. Empty is a valid answer. */
  search(surfaceForm: string, limit: number): Promise<ConceptCandidate[]>;
  /**
   * Hierarchy among and above the given concepts. This is what gives the
   * taxonomy view a real hierarchy for free — no clustering heuristic, no model.
   */
  hierarchy(conceptIds: readonly string[]): Promise<VocabularyHierarchy>;
}

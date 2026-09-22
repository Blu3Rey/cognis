/**
 * In-memory vocabulary — development and tests.
 *
 * A gazetteer of concepts with aliases, standing in for Wikidata and friends.
 * The real client is an HTTP call to a vocabulary API, proxied through the
 * backend so lookups are pooled and cached (docs/01-architecture.md).
 */

import type {
  VocabularyClient, ConceptCandidate, VocabularyEdge, VocabularyHierarchy,
} from '../ports/vocabulary.js';

export interface FixtureConcept extends ConceptCandidate {
  /** Vocabulary parents, for the taxonomy view. */
  parents?: string[];
}

function normalise(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export class FixtureVocabulary implements VocabularyClient {
  #byAlias = new Map<string, FixtureConcept[]>();
  #concepts: FixtureConcept[];

  constructor(concepts: readonly FixtureConcept[]) {
    this.#concepts = [...concepts];
    for (const c of this.#concepts) {
      for (const alias of [c.label, ...c.aliases]) {
        const key = normalise(alias);
        const list = this.#byAlias.get(key) ?? [];
        list.push(c);
        this.#byAlias.set(key, list);
      }
    }
  }

  async search(surfaceForm: string, limit: number): Promise<ConceptCandidate[]> {
    const key = normalise(surfaceForm);
    const exact = this.#byAlias.get(key) ?? [];

    // Substring fallback, so "spaced repetition systems" still retrieves
    // "spaced repetition". Real vocabulary APIs do their own fuzzy matching.
    const fuzzy = exact.length
      ? []
      : this.#concepts.filter((c) =>
          [c.label, ...c.aliases].some((a) => {
            const n = normalise(a);
            return n.includes(key) || key.includes(n);
          }),
        );

    return [...exact, ...fuzzy]
      .slice(0, limit)
      .map(({ parents: _parents, ...candidate }) => candidate);
  }

  async hierarchy(conceptIds: readonly string[]): Promise<VocabularyHierarchy> {
    const byId = new Map(this.#concepts.map((c) => [c.id, c]));
    const edges: VocabularyEdge[] = [];
    const reached = new Set<string>();

    // Walk upward to the root so the tree has a complete spine. A cycle in the
    // vocabulary would otherwise loop forever, so visited ids are tracked.
    const queue = [...conceptIds];
    const seen = new Set<string>(conceptIds);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const c = byId.get(id);
      if (!c) continue;
      reached.add(id);
      for (const parent of c.parents ?? []) {
        edges.push({ from: id, to: parent, relation: 'subclass_of' });
        reached.add(parent);
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }

    const concepts: ConceptCandidate[] = [];
    for (const id of reached) {
      const c = byId.get(id);
      if (c) {
        const { parents: _parents, ...candidate } = c;
        concepts.push(candidate);
      }
    }
    return { edges, concepts };
  }
}

/**
 * Deterministic rule-based linker — development and tests.
 *
 * Picks the candidate whose label best matches the surface form, and treats a
 * concept as primary when it recurs or appears in the title. It is not a
 * substitute for a model: it exists so the pipeline, the override layer, the
 * coverage rollup and the eval harness are all testable without a network
 * call, and so tests are deterministic.
 *
 * A real deployment injects a model-backed linker through the same port. The
 * eval harness in src/eval/linking.ts is what decides whether that linker is
 * good enough to build on.
 */

import type { Linker, LinkRequest, LinkDecision } from '../ports/linker.js';

function normalise(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export interface RuleLinkerOptions {
  modelId?: string;
  promptVersion?: string;
  /** Occurrences in the document above which a concept counts as primary. */
  primaryThreshold?: number;
}

export class RuleLinker implements Linker {
  readonly modelId: string;
  readonly promptVersion: string;
  readonly #primaryThreshold: number;

  constructor(opts: RuleLinkerOptions = {}) {
    this.modelId = opts.modelId ?? 'rule-linker-v1';
    this.promptVersion = opts.promptVersion ?? 'rules@1.0.0';
    this.#primaryThreshold = opts.primaryThreshold ?? 2;
  }

  async disambiguate(req: LinkRequest): Promise<LinkDecision[]> {
    const title = normalise(req.documentTitle ?? '');
    const text = normalise(req.chunkText);

    const out: LinkDecision[] = [];
    for (const mention of req.mentions) {
      const surface = normalise(mention.surfaceForm);

      let best: { id: string; score: number; label: string } | null = null;
      for (const c of mention.candidates) {
        const names = [c.label, ...c.aliases].map(normalise);
        let score = 0;
        if (names.includes(surface)) score = 1;
        else if (names.some((n) => n.includes(surface) || surface.includes(n))) score = 0.7;
        else continue;
        if (!best || score > best.score) best = { id: c.id, score, label: c.label };
      }

      if (!best) {
        out.push({
          surfaceForm: mention.surfaceForm,
          startChar: mention.startChar,
          endChar: mention.endChar,
          conceptId: null,
          confidence: 1,
          isPrimary: false,
        });
        continue;
      }

      const occurrences = text.split(surface).length - 1;
      const isPrimary =
        title.includes(surface) || occurrences >= this.#primaryThreshold;

      out.push({
        surfaceForm: mention.surfaceForm,
        startChar: mention.startChar,
        endChar: mention.endChar,
        conceptId: best.id,
        confidence: best.score,
        isPrimary,
      });
    }
    return out;
  }
}

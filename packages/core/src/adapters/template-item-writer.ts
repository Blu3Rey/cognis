/**
 * Deterministic item writer — development and tests.
 *
 * Builds cloze and free-recall items from evidence spans using templates, and
 * cites the exact offsets it drew from. It is not a substitute for a model:
 * real items need a model to compose a question worth answering. It exists so
 * the groundedness gate, the scheduler, grading and calibration are all
 * testable without a network call.
 */

import type {
  ItemWriter, ItemGenerationRequest, GeneratedItem, RubricPoint,
} from '../ports/item-writer.js';

export interface TemplateItemWriterOptions {
  modelId?: string;
  promptVersion?: string;
  /** Produce a citation that does not resolve, to exercise the gate. */
  emitBrokenCitations?: boolean;
}

/** First reasonably substantial sentence of a span. */
function firstSentence(text: string): { text: string; start: number; end: number } | null {
  const m = /[^.!?]{25,400}[.!?]/.exec(text);
  if (!m || m.index === undefined) return null;
  return { text: m[0].trim(), start: m.index, end: m.index + m[0].length };
}

export class TemplateItemWriter implements ItemWriter {
  readonly modelId: string;
  readonly promptVersion: string;
  readonly #broken: boolean;

  constructor(opts: TemplateItemWriterOptions = {}) {
    this.modelId = opts.modelId ?? 'template-writer-v1';
    this.promptVersion = opts.promptVersion ?? 'templates@1.0.0';
    this.#broken = opts.emitBrokenCitations ?? false;
  }

  async generate(req: ItemGenerationRequest): Promise<GeneratedItem[]> {
    const items: GeneratedItem[] = [];

    for (const kind of req.kinds) {
      if (items.length >= req.maxItems) break;

      if (kind === 'synthesis') {
        // Only possible with more than one source — which is the whole point
        // of the type, so it is skipped rather than faked.
        const sources = new Set(req.evidence.map((e) => e.sourceId));
        if (sources.size < 2) continue;
      }

      const points: RubricPoint[] = [];
      for (const [i, span] of req.evidence.slice(0, 3).entries()) {
        const sentence = firstSentence(span.text);
        if (!sentence) continue;
        const start = this.#broken
          ? span.endChar + 100_000
          : span.startChar + sentence.start;
        points.push({
          id: `p${i}`,
          text: sentence.text,
          citation: {
            documentVersionId: span.documentVersionId,
            startChar: start,
            endChar: this.#broken ? start + 10 : span.startChar + sentence.end,
          },
        });
      }
      if (points.length === 0) continue;

      const prompt =
        kind === 'cloze'
          ? `Complete from memory: "${points[0]!.text.replace(
              new RegExp(req.conceptLabel, 'i'), '_____',
            )}"`
          : kind === 'synthesis'
            ? `You have read about ${req.conceptLabel} in more than one source. ` +
              `How do they differ in what they claim?`
            : kind === 'application'
              ? `Describe a situation where ${req.conceptLabel} would apply, and why.`
              : `State the core claim about ${req.conceptLabel} and the evidence given for it.`;

      items.push({
        kind,
        prompt,
        expectedPoints: points,
        evidence: req.evidence,
        difficultyHint: kind === 'cloze' ? 0.3 : 0.6,
      });
    }

    return items;
  }
}

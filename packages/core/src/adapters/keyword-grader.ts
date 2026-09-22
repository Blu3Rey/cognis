/**
 * Deterministic grader — development and tests.
 *
 * Scores an answer by how many of the rubric points' distinctive terms it
 * contains. Crude by design: a real grader needs a model to judge whether an
 * answer conveys a point. This exists so the review flow, rating mapping and
 * calibration are testable deterministically.
 */

import type { Grader, GradeRequest, GradeResult } from '../ports/grader.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'that',
  'this', 'it', 'its', 'for', 'than', 'then', 'more', 'most', 'can', 'may',
]);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  );
}

export interface KeywordGraderOptions {
  modelId?: string;
  rubricVersion?: string;
  /** Fraction of a point's terms an answer must contain to meet it. */
  threshold?: number;
}

export class KeywordGrader implements Grader {
  readonly modelId: string;
  readonly rubricVersion: string;
  readonly #threshold: number;

  constructor(opts: KeywordGraderOptions = {}) {
    this.modelId = opts.modelId ?? 'keyword-grader-v1';
    this.rubricVersion = opts.rubricVersion ?? 'keywords@1.0.0';
    this.#threshold = opts.threshold ?? 0.4;
  }

  async grade(req: GradeRequest): Promise<GradeResult> {
    const answer = terms(req.answerText);
    const points = req.expectedPoints.map((p) => {
      const expected = terms(p.text);
      let shared = 0;
      for (const t of expected) if (answer.has(t)) shared++;
      const ratio = expected.size === 0 ? 0 : shared / expected.size;
      return {
        pointId: p.id,
        met: ratio >= this.#threshold,
        note: `matched ${shared}/${expected.size} distinctive terms`,
      };
    });

    const met = points.filter((p) => p.met).length;
    const score = points.length === 0 ? 0 : met / points.length;

    return {
      score,
      points,
      rationaleForUser:
        points.length === 0
          ? 'This item has no rubric to grade against.'
          : `You covered ${met} of ${points.length} expected points.`,
    };
  }
}

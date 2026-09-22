/**
 * Grader port — judging a free-text answer against an item's rubric.
 *
 * The grade is a judgment and may be re-run with a better model or a revised
 * rubric. The answer is evidence and is stored verbatim
 * (docs/05-retention-engine.md § Grading).
 */

import type { RubricPoint } from './item-writer.js';

export interface GradeRequest {
  prompt: string;
  answerText: string;
  expectedPoints: RubricPoint[];
  /** The cited source text, so the grader judges against the corpus. */
  evidenceText: string;
}

export interface GradeResult {
  /** 0..1 over the rubric. */
  score: number;
  points: { pointId: string; met: boolean; note?: string }[];
  /** Shown to the user; never stored as corpus. */
  rationaleForUser: string;
}

export interface Grader {
  readonly modelId: string;
  readonly rubricVersion: string;
  grade(req: GradeRequest): Promise<GradeResult>;
}

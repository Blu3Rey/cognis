/**
 * The engagement prior — a HYPOTHESIS, not an established result.
 *
 * The levels-of-processing literature supports the ORDERING: material the
 * reader annotated, applied or taught tends to be retained better than
 * material they skimmed. It does not supply the magnitudes below, which are
 * a starting guess.
 *
 * So this is a testable claim wired into the system on purpose: it scales the
 * initial stability of a new item by how deeply the user engaged with the
 * material the item came from, and M5's completion criterion is to measure
 * whether doing so improves scheduler calibration against the same review log
 * without it (docs/11-roadmap.md § M5).
 *
 * If it does not, the honest response is to set every multiplier to 1 and
 * shrink the reader's scope — which is a real finding about the premise, not a
 * failure.
 */

import type { Engagement } from '../types.js';

export const ENGAGEMENT_PRIOR_VERSION = '1.0.0-hypothesis';

export interface EngagementPrior {
  version: string;
  /** Multiplier applied to a new item's initial stability. */
  multipliers: Record<Engagement | 'unknown', number>;
}

export const DEFAULT_ENGAGEMENT_PRIOR: EngagementPrior = {
  version: ENGAGEMENT_PRIOR_VERSION,
  multipliers: {
    skim: 0.8,
    read: 1.0,
    annotate: 1.25,
    apply: 1.5,
    teach: 1.8,
    unknown: 1.0,
  },
};

/** The null hypothesis: engagement carries no information about retention. */
export const NEUTRAL_ENGAGEMENT_PRIOR: EngagementPrior = {
  version: 'neutral@1.0.0',
  multipliers: {
    skim: 1, read: 1, annotate: 1, apply: 1, teach: 1, unknown: 1,
  },
};

export function multiplierFor(
  prior: EngagementPrior,
  engagement: Engagement | null,
): number {
  return prior.multipliers[engagement ?? 'unknown'] ?? 1;
}

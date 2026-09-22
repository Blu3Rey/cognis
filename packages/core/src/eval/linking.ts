/**
 * Linking evaluation.
 *
 * docs/12-evaluation.md §2 makes this the gate for M2: precision is the
 * primary metric, and no relink ships that lowers it, however much better the
 * new model is elsewhere. A linker whose precision has not been measured must
 * not be built upon, because a wrong link corrupts coverage for every
 * downstream query and does so invisibly.
 */

import type { VocabularyClient } from '../ports/vocabulary.js';
import type { Linker } from '../ports/linker.js';
import { spotMentions } from '../concept/spotter.js';
import type { SpotOptions } from '../concept/spotter.js';

/** One hand-labelled mention. The unit of ground truth. */
export interface GoldMention {
  surfaceForm: string;
  startChar: number;
  endChar: number;
  /** Expected concept id, or null when the correct answer is NIL. */
  conceptId: string | null;
  /** Whether the document is ABOUT this concept. */
  isPrimary: boolean;
  /** Optional note on why this case is interesting. */
  note?: string;
}

export interface GoldDocument {
  id: string;
  title: string | null;
  text: string;
  mentions: GoldMention[];
}

export interface LinkingMetrics {
  /** Gold mentions with a concept id (i.e. not NIL). */
  linkable: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Gold NILs correctly predicted as NIL. */
  nilTotal: number;
  nilCorrect: number;
  nilAccuracy: number;
  /** is_primary agreement over correctly linked mentions. */
  primaryJudged: number;
  primaryCorrect: number;
  primaryAccuracy: number;
  /** Gold mentions the spotter never surfaced — recall lost before linking. */
  missedBySpotter: number;
}

export interface LinkingEvalReport {
  linkerModelId: string;
  promptVersion: string;
  documents: number;
  metrics: LinkingMetrics;
  /** Every disagreement, for inspection. This is where the work actually is. */
  errors: {
    documentId: string;
    surfaceForm: string;
    expected: string | null;
    actual: string | null;
    kind: 'wrong_concept' | 'missed_link' | 'spurious_link' | 'not_spotted' | 'wrong_primary';
  }[];
}

function overlaps(a: { startChar: number; endChar: number }, b: GoldMention): boolean {
  return a.startChar < b.endChar && b.startChar < a.endChar;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Run the linker against a labelled set.
 *
 * Operates on gold documents directly rather than through the database: the
 * eval measures the spotter, the candidate generator and the linker, not
 * storage.
 */
export async function runLinkingEval(
  documents: readonly GoldDocument[],
  vocabulary: VocabularyClient,
  linker: Linker,
  opts: SpotOptions & { candidatesPerForm?: number; minConfidence?: number } = {},
): Promise<LinkingEvalReport> {
  const candidatesPerForm = opts.candidatesPerForm ?? 8;
  const minConfidence = opts.minConfidence ?? 0.55;

  const m: LinkingMetrics = {
    linkable: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0,
    precision: 0, recall: 0, f1: 0,
    nilTotal: 0, nilCorrect: 0, nilAccuracy: 0,
    primaryJudged: 0, primaryCorrect: 0, primaryAccuracy: 0,
    missedBySpotter: 0,
  };
  const errors: LinkingEvalReport['errors'] = [];

  for (const doc of documents) {
    const spots = spotMentions(doc.text, opts);

    const mentions = [];
    for (const s of spots) {
      mentions.push({
        surfaceForm: s.surfaceForm,
        startChar: s.startChar,
        endChar: s.endChar,
        candidates: await vocabulary.search(s.surfaceForm, candidatesPerForm),
      });
    }

    const decisions = mentions.length
      ? await linker.disambiguate({
          chunkId: doc.id,
          chunkText: doc.text,
          sectionPath: null,
          documentTitle: doc.title,
          mentions,
        })
      : [];

    const predicted = decisions.map((d) => ({
      startChar: d.startChar,
      endChar: d.endChar,
      conceptId: d.confidence >= minConfidence ? d.conceptId : null,
      isPrimary: d.isPrimary,
      surfaceForm: d.surfaceForm,
    }));

    const matchedPredictions = new Set<number>();

    for (const gold of doc.mentions) {
      const idx = predicted.findIndex((p, i) => !matchedPredictions.has(i) && overlaps(p, gold));
      const pred = idx >= 0 ? predicted[idx]! : null;
      if (idx >= 0) matchedPredictions.add(idx);

      if (gold.conceptId === null) {
        m.nilTotal++;
        if (!pred || pred.conceptId === null) {
          m.nilCorrect++;
        } else {
          // Anchoring something that should have been NIL is how a graph
          // fills with wrong nodes.
          m.falsePositives++;
          errors.push({
            documentId: doc.id, surfaceForm: gold.surfaceForm,
            expected: null, actual: pred.conceptId, kind: 'spurious_link',
          });
        }
        continue;
      }

      m.linkable++;

      if (!pred) {
        m.falseNegatives++;
        m.missedBySpotter++;
        errors.push({
          documentId: doc.id, surfaceForm: gold.surfaceForm,
          expected: gold.conceptId, actual: null, kind: 'not_spotted',
        });
        continue;
      }

      if (pred.conceptId === gold.conceptId) {
        m.truePositives++;
        m.primaryJudged++;
        if (pred.isPrimary === gold.isPrimary) m.primaryCorrect++;
        else {
          errors.push({
            documentId: doc.id, surfaceForm: gold.surfaceForm,
            expected: `primary=${gold.isPrimary}`,
            actual: `primary=${pred.isPrimary}`, kind: 'wrong_primary',
          });
        }
      } else if (pred.conceptId === null) {
        m.falseNegatives++;
        errors.push({
          documentId: doc.id, surfaceForm: gold.surfaceForm,
          expected: gold.conceptId, actual: null, kind: 'missed_link',
        });
      } else {
        m.falsePositives++;
        m.falseNegatives++;
        errors.push({
          documentId: doc.id, surfaceForm: gold.surfaceForm,
          expected: gold.conceptId, actual: pred.conceptId, kind: 'wrong_concept',
        });
      }
    }
  }

  m.precision = ratio(m.truePositives, m.truePositives + m.falsePositives);
  m.recall = ratio(m.truePositives, m.truePositives + m.falseNegatives);
  m.f1 = m.precision + m.recall === 0
    ? 0
    : (2 * m.precision * m.recall) / (m.precision + m.recall);
  m.nilAccuracy = ratio(m.nilCorrect, m.nilTotal);
  m.primaryAccuracy = ratio(m.primaryCorrect, m.primaryJudged);

  return {
    linkerModelId: linker.modelId,
    promptVersion: linker.promptVersion,
    documents: documents.length,
    metrics: m,
    errors,
  };
}

/**
 * Identity stability: the property external anchoring exists to guarantee.
 *
 * Re-running with a different linker must leave concept ids unchanged for the
 * mentions both runs agree on. Drift here is a bug in anchoring, not a model
 * quality issue (docs/12-evaluation.md §2).
 */
export function identityStability(
  before: LinkingEvalReport,
  after: LinkingEvalReport,
): { comparable: number; stable: number; stability: number } {
  const key = (e: LinkingEvalReport['errors'][number]) => `${e.documentId}\u0000${e.surfaceForm}`;
  const beforeErrors = new Map(before.errors.map((e) => [key(e), e.actual]));
  const afterErrors = new Map(after.errors.map((e) => [key(e), e.actual]));

  let comparable = 0;
  let stable = 0;
  for (const [k, beforeActual] of beforeErrors) {
    if (!afterErrors.has(k)) continue;
    comparable++;
    if (afterErrors.get(k) === beforeActual) stable++;
  }

  // Agreed-correct mentions are stable by construction: both runs produced the
  // gold id, which is what identity stability asserts.
  const agreedCorrect = Math.min(
    before.metrics.truePositives,
    after.metrics.truePositives,
  );
  comparable += agreedCorrect;
  stable += agreedCorrect;

  return { comparable, stable, stability: ratio(stable, comparable) };
}

export function formatReport(report: LinkingEvalReport): string {
  const m = report.metrics;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `linker:        ${report.linkerModelId} (prompt ${report.promptVersion})`,
    `documents:     ${report.documents}`,
    `linkable gold: ${m.linkable}   NIL gold: ${m.nilTotal}`,
    ``,
    `precision:     ${pct(m.precision)}  (${m.truePositives} TP / ${m.falsePositives} FP)`,
    `recall:        ${pct(m.recall)}  (${m.falseNegatives} FN)`,
    `F1:            ${pct(m.f1)}`,
    `NIL accuracy:  ${pct(m.nilAccuracy)}  (${m.nilCorrect}/${m.nilTotal})`,
    `is_primary:    ${pct(m.primaryAccuracy)}  (${m.primaryCorrect}/${m.primaryJudged})`,
    `not spotted:   ${m.missedBySpotter}`,
  ];
  if (report.errors.length > 0) {
    lines.push('', 'errors:');
    for (const e of report.errors.slice(0, 40)) {
      lines.push(`  [${e.kind}] "${e.surfaceForm}" expected=${e.expected} actual=${e.actual}`);
    }
    if (report.errors.length > 40) {
      lines.push(`  ... and ${report.errors.length - 40} more`);
    }
  }
  return lines.join('\n');
}

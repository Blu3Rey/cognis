import type { GoldDocument } from '../../src/eval/linking.js';

/**
 * SEED linking eval set — a smoke set, NOT the real evaluation.
 *
 * docs/12-evaluation.md §2 requires at least 200 hand-labelled mentions across
 * 20+ documents spanning the user's actual reading mix, including ambiguous
 * acronyms, common-word surface forms, near-synonyms that must not merge,
 * genuine NILs, and one concept named differently in three sources.
 *
 * This file cannot be that set: real ground truth has to be labelled by hand
 * against a real corpus, and inventing it would produce an eval that measures
 * nothing while looking like it measures something. What this set does is
 * prove the harness computes the right metrics and catches the error classes
 * it claims to catch.
 *
 * See eval/README.md for how to grow the real one.
 */
export const GOLD: GoldDocument[] = [
  {
    id: 'doc-spacing',
    title: 'Spaced repetition in practice',
    text:
      'Spaced repetition is a learning technique that schedules reviews at ' +
      'expanding intervals. Spaced repetition outperforms massed study in ' +
      'nearly every controlled comparison. Practitioners often pair spaced ' +
      'repetition with active recall.',
    mentions: [
      {
        surfaceForm: 'Spaced repetition', startChar: 0, endChar: 17,
        conceptId: 'wd:Q1049444', isPrimary: true,
        note: 'appears in the title and recurs: clearly primary',
      },
      {
        surfaceForm: 'active recall', startChar: 213, endChar: 226,
        conceptId: 'wd:Q7825195', isPrimary: false,
        note: 'alias of the testing effect, mentioned once',
      },
    ],
  },
  {
    id: 'doc-interleaving',
    title: 'Why interleaving feels worse and works better',
    text:
      'Interleaving mixes topics within a study session. Learners rate ' +
      'interleaving as harder than blocking, yet interleaving produces better ' +
      'retention on delayed tests.',
    mentions: [
      {
        surfaceForm: 'Interleaving', startChar: 0, endChar: 12,
        conceptId: 'wd:Q189302', isPrimary: true,
      },
    ],
  },
  {
    id: 'doc-bread',
    title: 'A sourdough primer',
    text:
      'Sourdough fermentation depends on wild yeast and lactic acid bacteria. ' +
      'Hydration and ambient temperature govern the crumb. Sourdough rewards ' +
      'patience more than precision.',
    mentions: [
      {
        surfaceForm: 'Sourdough fermentation', startChar: 0, endChar: 22,
        conceptId: 'wd:Q160402', isPrimary: true,
      },
    ],
  },
  {
    id: 'doc-nil',
    title: 'Notes from a Tuesday',
    text:
      'Marcus Aurelius Brightwater described his weekend project in detail. ' +
      'The Frobnicator Assembly remains unfinished.',
    mentions: [
      {
        surfaceForm: 'Marcus Aurelius Brightwater', startChar: 0, endChar: 27,
        conceptId: null, isPrimary: false,
        note: 'a person with no vocabulary entry: the correct answer is NIL',
      },
      {
        surfaceForm: 'Frobnicator Assembly', startChar: 72, endChar: 92,
        conceptId: null, isPrimary: false,
        note: 'invented term: anchoring it to anything would be a false positive',
      },
    ],
  },
];

/**
 * The eval harness is the gate for M2 (docs/12 §2). These tests check that it
 * measures what it claims to — a harness that silently reports 100% is worse
 * than no harness, because the number gets believed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLinkingEval, identityStability, formatReport } from '../src/eval/linking.js';
import { FixtureVocabulary } from '../src/adapters/fixture-vocabulary.js';
import { RuleLinker } from '../src/adapters/rule-linker.js';
import { VOCABULARY } from './fixtures/vocabulary.js';
import { GOLD } from './fixtures/gold.js';
import type { GoldDocument } from '../src/eval/linking.js';

const vocabulary = new FixtureVocabulary(VOCABULARY);

test('reports precision, recall and NIL accuracy over the seed set', async () => {
  const report = await runLinkingEval(GOLD, vocabulary, new RuleLinker());
  const m = report.metrics;

  assert.ok(m.linkable > 0, 'the seed set must contain linkable mentions');
  assert.ok(m.nilTotal > 0, 'the seed set must contain genuine NILs');
  assert.ok(m.precision >= 0 && m.precision <= 1);
  assert.ok(m.recall >= 0 && m.recall <= 1);

  // Not a quality bar — the real gate needs the real labelled set. This only
  // asserts the harness is wired to the pipeline and produces live numbers.
  assert.ok(
    m.truePositives > 0,
    `expected some correct links; report:\n${formatReport(report)}`,
  );
});

test('a spurious anchor on a NIL is counted as a false positive', async () => {
  // A linker that anchors everything to the first candidate it sees.
  class EagerLinker extends RuleLinker {
    override async disambiguate(req: Parameters<RuleLinker['disambiguate']>[0]) {
      return req.mentions.map((m) => ({
        surfaceForm: m.surfaceForm,
        startChar: m.startChar,
        endChar: m.endChar,
        conceptId: m.candidates[0]?.id ?? 'wd:Q9081',
        confidence: 1,
        isPrimary: false,
      }));
    }
  }

  const strict = await runLinkingEval(GOLD, vocabulary, new RuleLinker());
  const eager = await runLinkingEval(GOLD, vocabulary, new EagerLinker());

  assert.ok(
    eager.metrics.nilAccuracy < strict.metrics.nilAccuracy,
    'over-eager anchoring must show up as worse NIL accuracy',
  );
  assert.ok(
    eager.errors.some((e) => e.kind === 'spurious_link'),
    'the error list must name the spurious links',
  );
});

test('a linker that anchors nothing scores zero recall, not zero errors', async () => {
  class NilLinker extends RuleLinker {
    override async disambiguate(req: Parameters<RuleLinker['disambiguate']>[0]) {
      return req.mentions.map((m) => ({
        surfaceForm: m.surfaceForm,
        startChar: m.startChar,
        endChar: m.endChar,
        conceptId: null,
        confidence: 1,
        isPrimary: false,
      }));
    }
  }

  const report = await runLinkingEval(GOLD, vocabulary, new NilLinker());
  assert.equal(report.metrics.truePositives, 0);
  assert.equal(report.metrics.recall, 0);
  assert.equal(report.metrics.nilAccuracy, 1, 'it does get the NILs right');
  assert.ok(report.errors.length > 0, 'silence is not success');
});

test('identity stability is high across a model change', async () => {
  const before = await runLinkingEval(GOLD, vocabulary, new RuleLinker());
  const after = await runLinkingEval(
    GOLD, vocabulary,
    new RuleLinker({ modelId: 'rule-linker-v2', promptVersion: 'rules@2.0.0' }),
  );

  const stability = identityStability(before, after);
  assert.ok(stability.comparable > 0);
  assert.equal(
    stability.stability, 1,
    'external anchoring means a model change must not move concept ids',
  );
});

test('the report renders without throwing on an empty set', async () => {
  const empty: GoldDocument[] = [];
  const report = await runLinkingEval(empty, vocabulary, new RuleLinker());
  assert.equal(report.metrics.precision, 0);
  assert.ok(formatReport(report).includes('documents:     0'));
});

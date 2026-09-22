/**
 * The M4 completion criterion (docs/11-roadmap.md):
 *
 *   "a slate of ten suggestions contains at least three the user calls
 *    non-obvious, and none is a near-duplicate of something already covered."
 *
 * The second half is mechanical and asserted in full below. The FIRST half is
 * not automatable: "non-obvious" is a human judgment about a real corpus, and
 * a test that scored it would be grading the ranker against my own guess at
 * what surprises the user.
 *
 * What is asserted instead is the structural property that makes
 * non-obviousness possible: that at least three suggestions rest on structural
 * evidence — convergent citations, coverage gaps, bridges — rather than on
 * similarity to what the user already reads. A slate of ten nearest-neighbours
 * would pass a redundancy check and still be worthless, so this is the part
 * worth guarding in code.
 *
 * Real acceptance needs the user rating a real slate. See docs/12 §6.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestPaper, ingestAndLink } from './helpers.js';

const PAPERS: [string, string, string][] = [
  ['10.1234/spacing',
   `Spaced repetition schedules reviews at expanding intervals producing durable
    retention. Spaced repetition strengthens the memory trace with each retrieval.`,
   'Spacing effects in learning'],
  ['10.1234/testing',
   `Retrieval practice strengthens memory more than rereading does. The testing
    effect appears across domains and ages. Retrieval practice works when it fails.`,
   'The critical importance of retrieval'],
  ['10.1234/interleaving',
   `Interleaving mixes topics within a single session. Interleaving lowers
    practice performance and raises delayed retention. Interleaving feels harder.`,
   'Interleaving in category learning'],
];

test('a ten-item slate rests on structural evidence and repeats nothing covered', async () => {
  const { cognis, clock } = await freshCognis();

  for (const [doi, text, title] of PAPERS) {
    await ingestPaper(cognis, doi, text, title);
    clock.advanceDays(12);
  }
  // A second, unrelated region of reading, so bridges and diversity have
  // something to work with.
  await ingestAndLink(cognis, 'https://example.com/bread',
    'Sourdough fermentation relies on wild yeast and lactic acid bacteria.', 'Bread');

  await cognis.rollupCoverage();
  await cognis.importHierarchy();
  await cognis.ingestCitations();
  await cognis.buildCooccurrence();

  const slate = await cognis.generateSuggestions({ limit: 10 });
  assert.ok(slate.length > 0, 'a corpus with citations must yield suggestions');
  assert.ok(slate.length <= 10, 'the slate is capped');

  // --- The mechanical half of the criterion: nothing already covered. ------

  for (const s of slate) {
    if (s.externalRef) {
      const held = await cognis.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM source WHERE doi = ?', [s.externalRef],
      );
      assert.equal(held!.n, 0, `suggested ${s.externalRef}, which is already in the corpus`);
    }
    if (s.conceptId) {
      const cov = await cognis.db.get<{ primary_sources: number }>(
        'SELECT primary_sources FROM coverage WHERE concept_id = ?', [s.conceptId],
      );
      // A concept the user has read *about* is covered, not a gap.
      assert.ok(
        (cov?.primary_sources ?? 0) === 0,
        `suggested ${s.conceptId}, which already has ${cov?.primary_sources} primary sources`,
      );
    }
  }

  // No duplicate targets within the slate.
  const keys = slate.map((s) => `${s.kind}:${s.externalRef ?? s.conceptId}`);
  assert.equal(new Set(keys).size, keys.length, 'a slate must not repeat itself');

  // --- The structural half: not a wall of similarity. ---------------------

  const structural = slate.filter(
    (s) => s.kind === 'citation_gap' || s.kind === 'coverage_gap' || s.kind === 'bridge',
  );
  assert.ok(
    structural.length >= 3,
    `expected >=3 structurally-evidenced suggestions, got ${structural.length} ` +
      `of ${slate.length}: ${JSON.stringify(slate.map((s) => s.kind))}`,
  );

  assert.ok(
    !slate.some((s) => s.kind === 'neighbour'),
    'embedding similarity is a last resort and must not appear while structural signals exist',
  );

  // Every suggestion is verifiable: the user can tap through to why.
  for (const s of slate) {
    assert.ok(Object.keys(s.reason.evidence).length > 0);
  }

  await cognis.close();
});

test('nothing is auto-ingested by generating suggestions', async () => {
  const { cognis } = await freshCognis();
  for (const [doi, text, title] of PAPERS) {
    await ingestPaper(cognis, doi, text, title);
  }
  await cognis.rollupCoverage();
  await cognis.ingestCitations();

  const before = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source');
  await cognis.generateSuggestions({ limit: 10 });
  const after = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source');

  assert.equal(
    after!.n, before!.n,
    'a suggestion is a report; acting on it is always an explicit user action',
  );
  await cognis.close();
});

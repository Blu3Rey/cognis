import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestPaper, ingestAndLink } from './helpers.js';

const PAPERS: [string, string, string][] = [
  ['10.1234/spacing',
   `Spaced repetition schedules reviews at expanding intervals producing durable
    retention. Spaced repetition strengthens the memory trace on each retrieval.`,
   'Spacing effects in learning'],
  ['10.1234/testing',
   `Retrieval practice strengthens memory more than rereading. The testing effect
    appears across domains. Retrieval practice works even when attempts fail.`,
   'The critical importance of retrieval'],
  ['10.1234/interleaving',
   `Interleaving mixes topics within a session. Interleaving lowers practice
    performance and raises delayed retention. Interleaving feels harder.`,
   'Interleaving in category learning'],
];

async function paperCorpus() {
  const { cognis, clock } = await freshCognis();
  for (const [doi, text, title] of PAPERS) {
    await ingestPaper(cognis, doi, text, title);
    clock.advanceDays(10);
  }
  await cognis.rollupCoverage();
  await cognis.ingestCitations();
  return { cognis, clock };
}

test('citation ingest records works and references without a model call', async () => {
  const { cognis } = await paperCorpus();
  const report = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM citation');
  assert.ok(report!.n > 0, 'expected citations');

  const works = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM work');
  assert.ok(works!.n >= 6, 'cited works must be recorded even when not in the corpus');

  // Works the user holds are linked back to their source.
  const held = await cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM work WHERE source_id IS NOT NULL',
  );
  assert.equal(held!.n, 3);
  await cognis.close();
});

test('convergent references surface a work every source cites and none holds', async () => {
  const { cognis } = await paperCorpus();
  const refs = await cognis.convergentReferences({ minCiting: 2 });

  const foundational = refs.find((r) => r.doi === '10.1111/foundational');
  assert.ok(foundational, `expected the convergent reference, got ${refs.map(r => r.doi)}`);
  assert.equal(foundational!.citingCount, 3, 'all three read papers cite it');
  assert.equal(foundational!.citingSourceIds.length, 3, 'evidence to tap through to');
  await cognis.close();
});

test('a work already in the corpus is not suggested', async () => {
  const { cognis } = await paperCorpus();
  const before = await cognis.convergentReferences({ minCiting: 2 });
  assert.ok(before.some((r) => r.doi === '10.1111/foundational'));

  // Now read it.
  await ingestPaper(cognis, '10.1111/foundational',
    'A foundational account of memory and forgetting over time.', 'Foundational');
  await cognis.ingestCitations();

  const after = await cognis.convergentReferences({ minCiting: 2 });
  assert.ok(
    !after.some((r) => r.doi === '10.1111/foundational'),
    'a gap the user has closed must stop being reported',
  );
  await cognis.close();
});

test('suggestions carry structured evidence, never prose', async () => {
  const { cognis } = await paperCorpus();
  const slate = await cognis.generateSuggestions({ limit: 10 });
  assert.ok(slate.length > 0);

  for (const s of slate) {
    assert.ok(s.reason.kind, 'every suggestion states its kind');
    assert.equal(typeof s.reason.evidence, 'object');
    assert.ok(
      Object.keys(s.reason.evidence).length > 0,
      'a reason with no evidence is a guess dressed as a fact',
    );
  }

  const citationGap = slate.find((s) => s.kind === 'citation_gap');
  if (citationGap) {
    const ev = citationGap.reason.evidence as { citingSourceIds: string[] };
    assert.ok(Array.isArray(ev.citingSourceIds) && ev.citingSourceIds.length >= 2);
  }
  await cognis.close();
});

test('citation evidence outranks weaker signals', async () => {
  const { cognis } = await paperCorpus();
  const slate = await cognis.generateSuggestions({ limit: 10 });

  const citation = slate.filter((s) => s.kind === 'citation_gap');
  const weak = slate.filter((s) => s.kind === 'taxonomy_hole' || s.kind === 'neighbour');
  if (citation.length > 0 && weak.length > 0) {
    assert.ok(
      Math.max(...citation.map((s) => s.score)) > Math.max(...weak.map((s) => s.score)),
      'ground truth from domain experts must outrank a vocabulary adjacency',
    );
  }
  await cognis.close();
});

test('a dismissed suggestion is not resurrected by the next slate', async () => {
  const { cognis } = await paperCorpus();
  const first = await cognis.generateSuggestions({ limit: 10 });
  assert.ok(first.length > 0);

  const target = first[0]!;
  await cognis.dismissSuggestion(target.id, 'not_interested');

  const second = await cognis.generateSuggestions({ limit: 10 });
  const key = target.externalRef ?? target.conceptId;
  assert.ok(
    !second.some((s) => (s.externalRef ?? s.conceptId) === key),
    'dismissal is respected and is data',
  );
  await cognis.close();
});

test('expired suggestions drop out of the active slate', async () => {
  const { cognis, clock } = await paperCorpus();
  await cognis.generateSuggestions({ limit: 10, ttlDays: 7 });
  assert.ok((await cognis.suggestions()).length > 0);

  clock.advanceDays(8);
  assert.equal(
    (await cognis.suggestions()).length, 0,
    'a slate is a current report, not an accumulating feed',
  );
  await cognis.close();
});

test('the largest cluster cannot dominate a slate', async () => {
  const { cognis, clock } = await freshCognis();
  // A corpus heavily weighted toward one topic: without a cap, every
  // suggestion would come from it.
  for (let i = 0; i < 6; i++) {
    await ingestAndLink(
      cognis, `https://example.com/memory-${i}`,
      `Spaced repetition and retrieval practice improve retention. The testing
       effect and spaced repetition are studied together. Interleaving too.`,
      `Memory research ${i}`,
    );
    clock.advanceDays(5);
  }
  await ingestAndLink(cognis, 'https://example.com/bread',
    'Sourdough fermentation relies on wild yeast and lactic acid bacteria.', 'Bread');

  await cognis.buildCooccurrence();
  const clusters = await cognis.conceptClusters({ minSize: 1 });
  assert.ok(clusters.length >= 1);

  const slate = await cognis.generateSuggestions({
    limit: 10, maxFromLargestClusterFraction: 0.4,
  });

  const largest = clusters[0]!;
  const fromLargest = slate.filter(
    (s) => s.conceptId && largest.conceptIds.includes(s.conceptId),
  ).length;
  assert.ok(
    fromLargest <= Math.max(1, Math.floor(10 * 0.4)),
    `the diversity cap is structural: ${fromLargest} of ${slate.length} from the top cluster`,
  );
  await cognis.close();
});

test('bridge gaps name two unconnected regions of reading', async () => {
  const { cognis } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/memory',
    'Spaced repetition and retrieval practice improve retention together.', 'Memory');
  await ingestAndLink(cognis, 'https://example.com/bread',
    'Sourdough fermentation relies on wild yeast and lactic acid bacteria.', 'Bread');

  await cognis.buildCooccurrence();
  const bridges = await cognis.bridgeGaps({ minClusterSize: 1, limit: 5 });

  assert.ok(bridges.length > 0, 'two unrelated topics must register as unbridged');
  const bridge = bridges[0]!;
  assert.ok(bridge.clusterA.conceptIds.length > 0);
  assert.ok(bridge.clusterB.conceptIds.length > 0);
  assert.ok(
    !bridge.clusterA.conceptIds.some((id) => bridge.clusterB.conceptIds.includes(id)),
    'clusters must be disjoint',
  );
  await cognis.close();
});

test('embedding neighbours only appear when structural signals are thin', async () => {
  const { cognis } = await freshCognis();
  // A corpus with no DOIs and almost no structure: nothing for citations,
  // bridges or coverage gaps to work with.
  await ingestAndLink(cognis, 'https://example.com/spacing',
    'Spaced repetition and retrieval practice improve retention over time.', 'Spacing');
  await ingestAndLink(cognis, 'https://example.com/spacing2',
    'Spaced repetition strengthens the memory trace with each retrieval.', 'More spacing');
  await cognis.importHierarchy();
  await cognis.buildCooccurrence();

  const withFallback = await cognis.generateSuggestions({
    limit: 10,
    kinds: ['citation_gap', 'coverage_gap', 'bridge', 'taxonomy_hole', 'neighbour'],
  });
  const withoutFallback = await cognis.generateSuggestions({
    limit: 10,
    kinds: ['citation_gap', 'coverage_gap', 'bridge', 'taxonomy_hole'],
  });

  // The fallback may or may not find anything, but it must never displace a
  // structural suggestion that would otherwise have been shown.
  const structuralWith = withFallback.filter((s) => s.kind !== 'neighbour').length;
  assert.ok(
    structuralWith >= Math.min(withoutFallback.length, withFallback.length),
    'similarity must fill a slate, never crowd out stronger evidence',
  );

  for (const s of withFallback.filter((x) => x.kind === 'neighbour')) {
    const ev = s.reason.evidence as { similarity: number; nearLabel: string };
    assert.ok(typeof ev.similarity === 'number', 'a neighbour must state its similarity');
    assert.ok(ev.nearLabel, 'and what it is near, so the user can judge it');
  }
  await cognis.close();
});

test('a neighbour never outranks a citation gap', async () => {
  const { cognis, clock } = await freshCognis();
  for (const [doi, text, title] of PAPERS) {
    await ingestPaper(cognis, doi, text, title);
    clock.advanceDays(10);
  }
  await cognis.rollupCoverage();
  await cognis.ingestCitations();
  await cognis.buildCooccurrence();

  const slate = await cognis.generateSuggestions({
    limit: 10,
    kinds: ['citation_gap', 'coverage_gap', 'bridge', 'taxonomy_hole', 'neighbour'],
  });

  const citations = slate.filter((s) => s.kind === 'citation_gap');
  const neighbours = slate.filter((s) => s.kind === 'neighbour');
  if (citations.length > 0 && neighbours.length > 0) {
    assert.ok(
      Math.min(...citations.map((s) => s.score)) >
        Math.max(...neighbours.map((s) => s.score)),
      'the redundancy penalty must keep similarity below ground truth',
    );
  }
  await cognis.close();
});

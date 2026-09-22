import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';
import { MAX_NEIGHBOURHOOD_NODES } from '../src/graph/neighbourhood.js';

async function graphCorpus() {
  const { cognis } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/memory',
    `Spaced repetition and retrieval practice improve retention. The testing
     effect and spaced repetition are studied together.`, 'Memory research');
  await ingestAndLink(cognis, 'https://example.com/interleaving',
    `Interleaving mixes topics within a session. Interleaving and spaced
     repetition are complementary.`, 'Interleaving');
  await cognis.importHierarchy();
  await cognis.buildCooccurrence();
  return cognis;
}

test('a neighbourhood is bounded and centred on its focus', async () => {
  const cognis = await graphCorpus();
  const n = await cognis.neighbourhood('wd:Q1049444', { hops: 2, maxNodes: 50 });

  assert.equal(n.focus, 'wd:Q1049444');
  assert.ok(n.nodes.length > 0);
  assert.ok(n.nodes.length <= 50);
  const focal = n.nodes.find((x) => x.conceptId === 'wd:Q1049444');
  assert.equal(focal?.distance, 0);
  for (const node of n.nodes) assert.ok(node.distance <= 2);
  await cognis.close();
});

test('the node cap is clamped to the rendering budget', async () => {
  const cognis = await graphCorpus();
  // A client asking for 10,000 nodes gets the budget, not a hairball.
  const n = await cognis.neighbourhood('wd:Q1049444', { maxNodes: 10_000 });
  assert.ok(n.nodes.length <= MAX_NEIGHBOURHOOD_NODES);
  await cognis.close();
});

test('edges carry provenance so a statistic is never styled as a fact', async () => {
  const cognis = await graphCorpus();
  const n = await cognis.neighbourhood('wd:Q1049444', { hops: 2 });

  assert.ok(n.edges.length > 0, 'expected edges');
  for (const e of n.edges) {
    assert.ok(
      ['vocabulary', 'citation_graph', 'corpus_stats', 'user'].includes(e.provenance),
      `unknown provenance ${e.provenance}`,
    );
  }
  const provenances = new Set(n.edges.map((e) => e.provenance));
  assert.ok(
    provenances.has('vocabulary') || provenances.has('corpus_stats'),
    'the corpus should produce at least one of these',
  );
  await cognis.close();
});

test('provenance can be filtered, so the client can show one kind of claim', async () => {
  const cognis = await graphCorpus();
  const onlyVocab = await cognis.neighbourhood('wd:Q1049444', {
    hops: 2, provenances: ['vocabulary'],
  });
  for (const e of onlyVocab.edges) assert.equal(e.provenance, 'vocabulary');
  await cognis.close();
});

test('uncovered neighbours are marked, making the coverage frontier visible', async () => {
  const cognis = await graphCorpus();
  const n = await cognis.neighbourhood('wd:Q1049444', { hops: 2 });

  for (const node of n.nodes) {
    assert.equal(
      node.uncovered, node.distinctSources === 0,
      'the uncovered flag must follow the coverage, not drift from it',
    );
  }
  await cognis.close();
});

test('an unknown concept yields an empty neighbourhood rather than throwing', async () => {
  const cognis = await graphCorpus();
  const n = await cognis.neighbourhood('wd:Q999999999');
  assert.deepEqual(n.nodes, []);
  assert.deepEqual(n.edges, []);
  await cognis.close();
});

test('every edge endpoint is present among the returned nodes', async () => {
  const cognis = await graphCorpus();
  const n = await cognis.neighbourhood('wd:Q1049444', { hops: 2, maxNodes: 20 });
  const ids = new Set(n.nodes.map((x) => x.conceptId));
  for (const e of n.edges) {
    assert.ok(ids.has(e.from), `edge from ${e.from} has no node`);
    assert.ok(ids.has(e.to), `edge to ${e.to} has no node`);
  }
  await cognis.close();
});

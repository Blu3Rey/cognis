/**
 * The Wikidata client, against recorded API shapes.
 *
 * wikidata.org is blocked in the environment this was written in, so the
 * fetcher is injected and the recorded payloads below are the real response
 * shapes from the MediaWiki API. What is verified is everything except the
 * socket: URL construction, parsing, id prefixing, the hierarchy walk, caching
 * and politeness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WikidataVocabulary, toConceptId, toQid, WIKIDATA_USER_AGENT,
} from '../src/adapters/wikidata-vocabulary.js';

const SEARCH_RESPONSE = {
  search: [
    {
      id: 'Q1049444',
      label: 'spaced repetition',
      description: 'learning technique with increasing intervals',
      aliases: ['distributed practice', 'spacing effect'],
    },
    {
      id: 'Q7075',
      label: 'library',
      description: 'organized collection of books',
    },
  ],
};

const ENTITIES_RESPONSE = {
  entities: {
    Q1049444: {
      id: 'Q1049444',
      labels: { en: { value: 'spaced repetition' } },
      descriptions: { en: { value: 'learning technique' } },
      aliases: { en: [{ value: 'distributed practice' }] },
      claims: {
        P279: [{ mainsnak: { datavalue: { value: { id: 'Q1148747' } } } }],
      },
    },
  },
};

const PARENT_RESPONSE = {
  entities: {
    Q1148747: {
      id: 'Q1148747',
      labels: { en: { value: 'learning technique' } },
      descriptions: { en: { value: 'method for acquiring knowledge' } },
      claims: {},
    },
  },
};

function recorder(routes: { match: RegExp; body: unknown }[]) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
    if (!route) throw new Error(`no recorded response for ${url}`);
    return route.body;
  };
  return { fetchJson, calls };
}

test('prefixes ids by scheme, so a QID can never collide with another vocabulary', () => {
  assert.equal(toConceptId('Q42'), 'wd:Q42');
  assert.equal(toQid('wd:Q42'), 'Q42');
  assert.equal(toQid('mesh:D000818'), null, 'a foreign scheme is not a Wikidata id');
});

test('search parses candidates with their aliases and descriptions', async () => {
  const { fetchJson, calls } = recorder([
    { match: /wbsearchentities/, body: SEARCH_RESPONSE },
  ]);
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 0 });

  const candidates = await vocab.search('spaced repetition', 5);

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.id, 'wd:Q1049444');
  assert.equal(candidates[0]!.scheme, 'wikidata');
  assert.equal(candidates[0]!.label, 'spaced repetition');
  assert.match(candidates[0]!.description!, /increasing intervals/);
  assert.deepEqual(candidates[0]!.aliases, ['distributed practice', 'spacing effect']);

  // The ambiguous second candidate must survive: discarding it here would
  // decide the disambiguation before the linker ever sees the choice.
  assert.equal(candidates[1]!.id, 'wd:Q7075');
  assert.match(calls[0]!, /search=spaced%20repetition/);
  assert.match(calls[0]!, /language=en/);
});

test('an empty surface form costs no request', async () => {
  const { fetchJson, calls } = recorder([]);
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 0 });
  assert.deepEqual(await vocab.search('   ', 5), []);
  assert.equal(calls.length, 0);
});

test('the limit is clamped to what the API accepts', async () => {
  const { fetchJson, calls } = recorder([
    { match: /wbsearchentities/, body: SEARCH_RESPONSE },
  ]);
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 0 });
  await vocab.search('x', 5000);
  assert.match(calls[0]!, /limit=50/);
});

test('the hierarchy walks upward and returns nodes as well as edges', async () => {
  const { fetchJson } = recorder([
    { match: /ids=Q1049444/, body: ENTITIES_RESPONSE },
    { match: /ids=Q1148747/, body: PARENT_RESPONSE },
  ]);
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 0 });

  const { edges, concepts } = await vocab.hierarchy(['wd:Q1049444']);

  assert.deepEqual(edges, [
    { from: 'wd:Q1049444', to: 'wd:Q1148747', relation: 'subclass_of' },
  ]);

  // The ancestor must come back as a node too, or the taxonomy view has no
  // spine to render and the hole is invisible.
  const ids = concepts.map((c) => c.id).sort();
  assert.deepEqual(ids, ['wd:Q1049444', 'wd:Q1148747']);
  assert.equal(concepts.find((c) => c.id === 'wd:Q1148747')!.label, 'learning technique');
});

test('non-Wikidata ids are ignored rather than sent as garbage', async () => {
  const { fetchJson, calls } = recorder([]);
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 0 });
  const result = await vocab.hierarchy(['mesh:D000818', 'local:something']);
  assert.deepEqual(result, { edges: [], concepts: [] });
  assert.equal(calls.length, 0);
});

test('the hierarchy walk terminates instead of climbing the upper ontology forever', async () => {
  // Every entity claims a parent, forever. Without a depth bound this would
  // fetch until the API stopped answering.
  let served = 0;
  const fetchJson = async (url: string) => {
    served++;
    const id = /ids=(Q\d+)/.exec(url)?.[1] ?? 'Q1';
    const next = `Q${Number(id.slice(1)) + 1}`;
    return {
      entities: {
        [id]: {
          id, labels: { en: { value: id } },
          claims: { P279: [{ mainsnak: { datavalue: { value: { id: next } } } }] },
        },
      },
    };
  };
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 0 });
  const { edges } = await vocab.hierarchy(['wd:Q1']);

  assert.ok(served > 0 && served <= 8, `walk should be bounded, made ${served} requests`);
  assert.ok(edges.length <= 8);
});

test('responses are cached on disk, so a second run costs nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wd-cache-'));
  try {
    const { fetchJson, calls } = recorder([
      { match: /wbsearchentities/, body: SEARCH_RESPONSE },
    ]);
    const first = new WikidataVocabulary({ fetchJson, cacheDir: dir, minIntervalMs: 0 });
    await first.search('spaced repetition', 5);
    assert.equal(calls.length, 1);

    // Candidate generation repeats the same lookups across every chunk; a
    // cache miss here would mean thousands of requests to a free public API.
    const second = new WikidataVocabulary({ fetchJson, cacheDir: dir, minIntervalMs: 0 });
    const candidates = await second.search('spaced repetition', 5);
    assert.equal(calls.length, 1, 'the second lookup should have been served from disk');
    assert.equal(candidates[0]!.id, 'wd:Q1049444');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('requests are spaced out', async () => {
  const stamps: number[] = [];
  const fetchJson = async () => {
    stamps.push(Date.now());
    return SEARCH_RESPONSE;
  };
  const vocab = new WikidataVocabulary({ fetchJson, minIntervalMs: 40 });

  await Promise.all([vocab.search('a', 3), vocab.search('b', 3), vocab.search('c', 3)]);

  assert.equal(stamps.length, 3);
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(
      stamps[i]! - stamps[i - 1]! >= 30,
      `requests ${i - 1} and ${i} were ${stamps[i]! - stamps[i - 1]!}ms apart`,
    );
  }
});

test('the user agent identifies the tool, as Wikimedia asks', () => {
  assert.match(WIKIDATA_USER_AGENT, /cognis/);
  assert.match(WIKIDATA_USER_AGENT, /https?:\/\//, 'must carry a contact URL');
});

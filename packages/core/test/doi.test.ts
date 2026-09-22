import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDoi, arxivIdFromUrl, arxivDoi } from '../src/canonical/doi.js';

test('accepts bare, prefixed and resolver-URL forms', () => {
  const expected = '10.1234/abc.def';
  for (const input of [
    '10.1234/abc.def',
    'doi:10.1234/abc.def',
    'https://doi.org/10.1234/abc.def',
    'https://dx.doi.org/10.1234/ABC.DEF',
  ]) {
    assert.equal(normaliseDoi(input), expected, `failed for ${input}`);
  }
});

test('extracts a DOI embedded in prose and strips trailing punctuation', () => {
  assert.equal(
    normaliseDoi('See the paper (doi:10.1000/xyz123).'),
    '10.1000/xyz123',
  );
});

test('returns null when there is no DOI, rather than throwing', () => {
  assert.equal(normaliseDoi('https://example.com/article'), null);
  assert.equal(normaliseDoi(''), null);
  assert.equal(normaliseDoi(null), null);
  assert.equal(normaliseDoi('10.1234'), null); // no suffix
});

test('maps an arXiv URL to its registered DOI', () => {
  const id = arxivIdFromUrl('https://arxiv.org/abs/2301.04567v2');
  assert.equal(id, '2301.04567');
  assert.equal(arxivDoi(id!), '10.48550/arxiv.2301.04567');
});

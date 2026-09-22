import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid, ulidTime, isUlid } from '../src/ids.js';

test('produces 26-character Crockford base32 ids', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.ok(isUlid(id), id);
});

test('encodes the timestamp recoverably', () => {
  const t = Date.UTC(2026, 0, 1);
  assert.equal(ulidTime(ulid(t)), t);
});

test('sorts lexicographically by creation time', () => {
  const early = ulid(Date.UTC(2026, 0, 1));
  const late = ulid(Date.UTC(2026, 5, 1));
  assert.ok(early < late);
});

test('is monotonic within a single millisecond', () => {
  const t = Date.UTC(2026, 0, 1);
  const ids = Array.from({ length: 100 }, () => ulid(t));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'ids minted in one ms must sort in mint order');
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
});

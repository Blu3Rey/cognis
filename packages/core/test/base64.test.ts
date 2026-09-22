/**
 * Base64 has its own tests because it sits underneath encryption: a decoder
 * that truncates produces "wrong passphrase" errors that look like a key
 * problem and are not. The original implementation subtracted the padding
 * count from an already-unpadded length, so it worked only when the input
 * length was a multiple of three — passing some tests and corrupting others.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBase64, fromBase64 } from '../src/sync/base64.js';

test('round-trips every length from 0 to 128', () => {
  for (let n = 0; n <= 128; n++) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) % 256;
    const decoded = fromBase64(toBase64(bytes));
    assert.equal(decoded.length, n, `length ${n} did not round-trip`);
    assert.deepEqual([...decoded], [...bytes], `content at length ${n} differs`);
  }
});

test('round-trips every byte value', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual([...fromBase64(toBase64(all))], [...all]);
});

test('pads to a multiple of four', () => {
  assert.equal(toBase64(new Uint8Array([1])).length % 4, 0);
  assert.equal(toBase64(new Uint8Array([1, 2])).length % 4, 0);
  assert.equal(toBase64(new Uint8Array([1, 2, 3])).length % 4, 0);
});

test('matches known vectors', () => {
  const enc = (s: string) => toBase64(new TextEncoder().encode(s));
  assert.equal(enc(''), '');
  assert.equal(enc('f'), 'Zg==');
  assert.equal(enc('fo'), 'Zm8=');
  assert.equal(enc('foo'), 'Zm9v');
  assert.equal(enc('foob'), 'Zm9vYg==');
  assert.equal(enc('fooba'), 'Zm9vYmE=');
  assert.equal(enc('foobar'), 'Zm9vYmFy');

  const dec = (s: string) => new TextDecoder().decode(fromBase64(s));
  assert.equal(dec('Zm9vYmFy'), 'foobar');
  assert.equal(dec('Zm9vYmE='), 'fooba');
  assert.equal(dec('Zg=='), 'f');
});

test('random buffers of awkward lengths survive', () => {
  for (const n of [1, 2, 3, 5, 7, 11, 13, 16, 17, 31, 32, 33, 1023, 1024]) {
    const bytes = new Uint8Array(n);
    globalThis.crypto.getRandomValues(bytes);
    assert.deepEqual([...fromBase64(toBase64(bytes))], [...bytes], `failed at ${n}`);
  }
});

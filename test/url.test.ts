import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseUrl, sameDocument } from '../src/canonical/url.js';

test('strips utm and other tracking parameters', () => {
  const { url, droppedParams } = canonicaliseUrl(
    'https://example.com/article?utm_source=x&utm_medium=y&id=42&fbclid=abc',
  );
  assert.equal(url, 'https://example.com/article?id=42');
  assert.deepEqual(droppedParams.sort(), ['fbclid', 'utm_medium', 'utm_source']);
});

test('normalises scheme, host case and www', () => {
  assert.equal(
    canonicaliseUrl('HTTP://WWW.Example.COM/Path').url,
    'https://example.com/Path',
  );
});

test('path case is preserved because paths are case-sensitive', () => {
  const a = canonicaliseUrl('https://example.com/Path').url;
  const b = canonicaliseUrl('https://example.com/path').url;
  assert.notEqual(a, b);
});

test('drops default ports and fragments, collapses slashes', () => {
  assert.equal(
    canonicaliseUrl('https://example.com:443//a//b/#section').url,
    'https://example.com/a/b',
  );
});

test('sorts query parameters so ordering does not create duplicates', () => {
  assert.equal(
    canonicaliseUrl('https://example.com/x?b=2&a=1').url,
    canonicaliseUrl('https://example.com/x?a=1&b=2').url,
  );
});

test('keeps the youtube video id but drops its share token', () => {
  const { url } = canonicaliseUrl('https://www.youtube.com/watch?v=abc123&si=track');
  assert.equal(url, 'https://youtube.com/watch?v=abc123');
});

test('rel=canonical outranks the requested URL', () => {
  const { url } = canonicaliseUrl('https://example.com/amp/story?utm_source=x', {
    relCanonical: 'https://example.com/story',
  });
  assert.equal(url, 'https://example.com/story');
});

test('http and https forms of one article collapse to one identity', () => {
  assert.ok(sameDocument('http://example.com/a/', 'https://www.example.com/a'));
});

test('rejects non-http schemes and unparseable input', () => {
  assert.throws(() => canonicaliseUrl('ftp://example.com/x'), TypeError);
  assert.throws(() => canonicaliseUrl('not a url'), TypeError);
});

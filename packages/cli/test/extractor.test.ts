/**
 * Extraction is where cognis first meets a real document, and where the long
 * tail lives. These use real HTML shapes rather than tidy fixtures, because
 * the failure modes that matter — consent walls, JS shells, nav chrome — all
 * look like valid HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHtml, extractPlainText, ExtractionError, MIN_ARTICLE_WORDS,
} from '../src/adapters/extractor.js';

const body = (paragraphs: string[]) => paragraphs.map((p) => `<p>${p}</p>`).join('');

const REAL_ARTICLE = `<!doctype html>
<html lang="en-GB">
<head>
  <title>Spacing effects in learning — Example</title>
  <link rel="canonical" href="/articles/spacing">
  <meta property="og:site_name" content="Example Review">
  <meta property="article:published_time" content="2024-03-11T09:00:00Z">
</head>
<body>
  <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
  <div class="cookie-banner">We use cookies. Accept all? Manage preferences.</div>
  <article>
    <h1>Spacing effects in learning</h1>
    <p class="byline">By A Writer</p>
    ${body([
      'Spaced repetition schedules reviews at expanding intervals, which produces markedly more durable retention than massing the same amount of practice into one sitting.',
      'The effect has been replicated across verbal learning, motor skills, and classroom instruction, and it holds for children and adults alike.',
      'Practitioners often pair it with retrieval practice, since each successful recall both measures and strengthens the memory trace it depends on.',
    ])}
    <h2>Why it works</h2>
    ${body([
      'One account holds that a longer gap makes retrieval harder, and that the additional effort is itself what consolidates the memory.',
      'A competing account emphasises encoding variability: each spaced encounter happens in a slightly different context, giving more retrieval routes later.',
    ])}
  </article>
  <aside class="related">Related: Ten productivity hacks</aside>
  <footer>© Example Review. Subscribe to our newsletter.</footer>
</body></html>`;

test('extracts the article and discards the chrome', () => {
  const doc = extractHtml(REAL_ARTICLE, 'https://example.com/articles/spacing?utm_source=x');

  assert.match(doc.title!, /Spacing effects/);
  assert.ok(doc.wordCount > 80, `expected a real word count, got ${doc.wordCount}`);

  // Everything that is not the article must be gone.
  for (const junk of ['cookie', 'Accept all', 'Subscribe to our newsletter', 'productivity hacks']) {
    assert.ok(!doc.text.includes(junk), `chrome leaked into the text: "${junk}"`);
  }
  assert.ok(doc.text.includes('expanding intervals'));
  assert.ok(doc.text.includes('encoding variability'));
});

test('resolves a relative canonical URL against the request URL', () => {
  const doc = extractHtml(REAL_ARTICLE, 'https://example.com/articles/spacing?utm_source=x');
  // The publisher is authoritative about which URL denotes the article, and a
  // relative canonical is common.
  assert.equal(doc.canonicalUrl, 'https://example.com/articles/spacing');
});

test('captures metadata the pipeline downstream relies on', () => {
  const doc = extractHtml(REAL_ARTICLE, 'https://example.com/articles/spacing');
  assert.equal(doc.lang, 'en-GB');
  assert.equal(doc.publishedAt, '2024-03-11T09:00:00.000Z');
  assert.equal(doc.siteName, 'Example Review');
  assert.match(doc.byline ?? '', /A Writer/);
});

test('normalises whitespace into paragraphs the chunker can read', () => {
  const doc = extractHtml(REAL_ARTICLE, 'https://example.com/a');
  assert.ok(!/\n{3,}/.test(doc.text), 'no runs of blank lines');
  assert.ok(!/[ \t]{2,}/.test(doc.text), 'no runs of spaces');
  assert.equal(doc.text, doc.text.trim());
});

test('a consent wall is a clean failure, not a junk extraction', () => {
  const wall = `<!doctype html><html><body>
    <div><h1>We value your privacy</h1>
    <p>We and our 842 partners store cookies.</p>
    <button>Accept</button></div></body></html>`;

  // Storing a cookie banner as an article is counted as a defect in docs/12,
  // so this must fail rather than succeed quietly.
  assert.throws(
    () => extractHtml(wall, 'https://example.com/a'),
    (err: unknown) => err instanceof ExtractionError && /too_short|no_content/.test(err.reason),
  );
});

test('a JS-only shell fails with a reason worth reading', () => {
  const shell = `<!doctype html><html><body><div id="root"></div>
    <script>window.__DATA__={}</script></body></html>`;
  assert.throws(
    () => extractHtml(shell, 'https://example.com/a'),
    (err: unknown) => err instanceof ExtractionError && err.message.length > 20,
  );
});

test('the short-article threshold is where it claims to be', () => {
  const words = Array.from({ length: MIN_ARTICLE_WORDS + 40 }, (_, i) => `word${i}`).join(' ');
  const doc = extractHtml(
    `<!doctype html><html><body><article><h1>Title</h1><p>${words}</p></article></body></html>`,
    'https://example.com/a',
  );
  assert.ok(doc.wordCount >= MIN_ARTICLE_WORDS);
});

test('plain text and markdown need no extraction, only tidying', () => {
  const doc = extractPlainText('# Spaced repetition\n\n\n\nReviews   at expanding intervals.\n');
  assert.equal(doc.title, 'Spaced repetition');
  assert.equal(doc.text, '# Spaced repetition\n\nReviews at expanding intervals.');
  assert.equal(doc.wordCount, 7);
});

test('an empty file is an error, not an empty document', () => {
  assert.throws(() => extractPlainText('   \n\n  '), ExtractionError);
});

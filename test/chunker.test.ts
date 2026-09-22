import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/chunk/chunker.js';

const DOC = `# Retrieval Practice

Testing yourself is more effective than re-reading. This is among the most
replicated findings in the study of memory.

## Spacing

Distributing practice over time beats massing it. The effect holds across
domains and age groups.

### Optimal intervals

Intervals should expand as material is learned.

## Interleaving

Mixing topics within a session lowers performance during practice and raises
retention afterwards.
`;

test('offsets point at the real text in the document', () => {
  const chunks = chunkText(DOC);
  assert.ok(chunks.length > 0);
  for (const c of chunks) {
    const slice = DOC.slice(c.startChar, c.endChar);
    // Every chunk's recorded span must contain its own opening text: evidence
    // spans and citation anchoring depend on these offsets being real.
    const head = c.text.split('\n')[0]!.slice(0, 20);
    assert.ok(
      slice.includes(head.trim()) || c.text.includes(slice.trim().slice(0, 20)),
      `chunk ${c.ordinal} offsets do not match its text`,
    );
    assert.ok(c.endChar > c.startChar);
    assert.ok(c.endChar <= DOC.length);
  }
});

test('builds a heading breadcrumb', () => {
  const chunks = chunkText(DOC);
  const paths = chunks.map((c) => c.sectionPath);
  assert.ok(
    paths.some((p) => p?.includes('Retrieval Practice')),
    `expected a top-level section path, got ${JSON.stringify(paths)}`,
  );
  assert.ok(
    paths.some((p) => p?.includes('Spacing') && p.includes('Optimal intervals')),
    `expected a nested breadcrumb, got ${JSON.stringify(paths)}`,
  );
});

test('pops the heading stack when a sibling section starts', () => {
  const chunks = chunkText(DOC);
  const interleaving = chunks.find((c) => c.text.includes('Mixing topics'));
  assert.ok(interleaving);
  // "Interleaving" is a sibling of "Spacing", so the deeper subsection must
  // not still be on the breadcrumb.
  assert.ok(!interleaving!.sectionPath?.includes('Optimal intervals'));
  assert.ok(interleaving!.sectionPath?.includes('Interleaving'));
});

test('is deterministic, so re-chunking is a rebuild not a mutation', () => {
  assert.deepEqual(chunkText(DOC), chunkText(DOC));
});

test('splits a paragraph that exceeds the budget on sentence boundaries', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i}.`).join(' ');
  const chunks = chunkText(long, { targetChars: 200, overlapChars: 0 });
  assert.ok(chunks.length > 1, 'a long paragraph must be split');
  for (const c of chunks) assert.ok(c.text.length <= 400, 'chunks stay near budget');
});

test('ordinals are contiguous from zero', () => {
  const chunks = chunkText(DOC);
  assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
});

test('empty and whitespace input produce no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

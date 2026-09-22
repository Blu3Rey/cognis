/**
 * User corrections are attested and must survive every rebuild. A rebuild that
 * silently discards them teaches the user their corrections do not stick, and
 * they stop making them (docs/04 § User corrections are sacred).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';
import { resolveConceptId } from '../src/concept/overrides.js';

const SPACING = `Spaced repetition schedules reviews at expanding intervals.
Spaced repetition beats massed study. Tools pair spaced repetition with active
recall.`;

test('a rejected mention stays rejected after a relink', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', SPACING, 'Spacing');
  await cognis.linkDocument(doc.documentVersionId);

  const mention = await cognis.db.get<{ chunk_id: string; concept_id: string }>(
    `SELECT chunk_id, concept_id FROM mention WHERE concept_id = 'wd:Q7825195' LIMIT 1`,
  );
  assert.ok(mention, 'fixture must produce the mention we are about to reject');

  await cognis.assert({
    kind: 'mention_reject',
    subjectType: 'mention',
    subjectId: mention!.chunk_id,
    objectId: mention!.concept_id,
    note: 'not what this article is about',
  });

  await cognis.linkDocument(doc.documentVersionId);

  const survived = await cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM mention WHERE chunk_id = ? AND concept_id = ?',
    [mention!.chunk_id, mention!.concept_id],
  );
  assert.equal(survived?.n, 0, 'the relink resurrected a rejected link');
  await cognis.close();
});

test('a merged concept stays merged after a relink', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', SPACING, 'Spacing');
  await cognis.linkDocument(doc.documentVersionId);

  await cognis.assert({
    kind: 'concept_merge',
    subjectType: 'concept',
    subjectId: 'wd:Q7825195',
    objectId: 'wd:Q1049444',
  });
  await cognis.linkDocument(doc.documentVersionId);

  const merged = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mention WHERE concept_id = 'wd:Q7825195'`,
  );
  assert.equal(merged?.n, 0, 'mentions must follow the merge');

  await cognis.linkAll();
  const stillMerged = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mention WHERE concept_id = 'wd:Q7825195'`,
  );
  assert.equal(stillMerged?.n, 0, 'a full relink must re-apply the merge too');
  await cognis.close();
});

test('a forced mention is re-added after a relink', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/bread',
    'Hydration and temperature govern the crumb.', 'Bread notes');
  await cognis.linkDocument(doc.documentVersionId);

  const chunk = await cognis.db.get<{ id: string }>(
    'SELECT id FROM chunk WHERE document_version_id = ? LIMIT 1',
    [doc.documentVersionId],
  );
  await cognis.db.run(
    `INSERT INTO concept (id, scheme, label) VALUES ('wd:Q160402','wikidata','Sourdough')
     ON CONFLICT (id) DO NOTHING`,
  );
  await cognis.assert({
    kind: 'mention_add',
    subjectType: 'mention',
    subjectId: chunk!.id,
    objectId: 'wd:Q160402',
    note: 'this is obviously about sourdough',
  });

  await cognis.linkDocument(doc.documentVersionId);
  const forced = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mention WHERE chunk_id = ? AND concept_id = 'wd:Q160402'`,
    [chunk!.id],
  );
  assert.equal(forced?.n, 1, 'the user-added link must survive the rebuild');
  await cognis.close();
});

test('merge chains resolve, and a cycle terminates instead of hanging', () => {
  const chain = new Map([['c', 'b'], ['b', 'a']]);
  assert.equal(resolveConceptId(chain, 'c'), 'a');

  // A user who merges A into B and later B into A would otherwise loop.
  const cycle = new Map([['a', 'b'], ['b', 'a']]);
  const resolved = resolveConceptId(cycle, 'a');
  assert.ok(resolved === 'a' || resolved === 'b');
  assert.equal(resolveConceptId(cycle, 'a'), resolveConceptId(cycle, 'a'));
});

test('a blocked pair is never proposed for merge again', async () => {
  const { cognis } = await freshCognis();
  await ingest(cognis, 'https://example.com/a',
    'The Frobnicator Assembly is unfinished. Frobnicator Assembly parts are scarce.', 'A');
  await ingest(cognis, 'https://example.com/b',
    'Frobnicator Assemblies were discontinued. Frobnicator Assemblies are rare.', 'B');

  const docs = await cognis.db.all<{ id: string }>('SELECT id FROM document_version');
  for (const d of docs) await cognis.linkDocument(d.id);

  const before = await cognis.proposeMerges({ minCentroidSimilarity: 0 });
  assert.ok(before.length > 0, 'near-identical local labels should be proposed');

  await cognis.assert({
    kind: 'concept_split',
    subjectType: 'concept',
    subjectId: before[0]!.fromConceptId,
    objectId: before[0]!.toConceptId,
    note: 'these are genuinely different',
  });

  const after = await cognis.proposeMerges({ minCentroidSimilarity: 0 });
  const stillThere = after.some(
    (p) =>
      (p.fromConceptId === before[0]!.fromConceptId &&
        p.toConceptId === before[0]!.toConceptId) ||
      (p.fromConceptId === before[0]!.toConceptId &&
        p.toConceptId === before[0]!.fromConceptId),
  );
  assert.equal(stillThere, false, 'a user who said "different" must not be asked again');
  await cognis.close();
});

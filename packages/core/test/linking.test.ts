import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';

const SPACING = `Spaced repetition schedules reviews at expanding intervals.
Spaced repetition beats massed study. Many tools pair spaced repetition with
active recall.`;

const TESTING = `Retrieval practice strengthens memory. The testing effect is
among the most replicated findings in learning science, and retrieval practice
is its practical form.`;

test('links surface forms to external concept ids', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/spacing', SPACING,
    'Spaced repetition in practice');

  const report = await cognis.linkDocument(doc.documentVersionId);
  assert.ok(report.anchored > 0, 'expected at least one anchored mention');

  const mentions = await cognis.db.all<{ concept_id: string; is_primary: number }>(
    `SELECT DISTINCT m.concept_id, m.is_primary FROM mention m
       JOIN chunk c ON c.id = m.chunk_id
      WHERE c.document_version_id = ?`,
    [doc.documentVersionId],
  );
  const ids = mentions.map((m) => m.concept_id);
  assert.ok(ids.includes('wd:Q1049444'), `expected spaced repetition, got ${ids}`);
  await cognis.close();
});

test('two sources naming a concept differently resolve to one id', async () => {
  const { cognis } = await freshCognis();
  // "active recall" and "retrieval practice" are aliases of one concept. This
  // cross-source merging is the whole argument for external anchoring.
  const a = await ingest(cognis, 'https://example.com/a', SPACING, 'Spacing');
  const b = await ingest(cognis, 'https://example.com/b', TESTING, 'Testing effect');

  await cognis.linkDocument(a.documentVersionId);
  await cognis.linkDocument(b.documentVersionId);

  const sources = await cognis.db.all<{ source_id: string }>(
    `SELECT DISTINCT dv.source_id AS source_id
       FROM mention m
       JOIN chunk c ON c.id = m.chunk_id
       JOIN document_version dv ON dv.id = c.document_version_id
      WHERE m.concept_id = 'wd:Q7825195'`,
  );
  assert.equal(sources.length, 2, 'one concept must span both sources');
  await cognis.close();
});

test('is_primary distinguishes being about a concept from mentioning it', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/spacing', SPACING,
    'Spaced repetition in practice');
  await cognis.linkDocument(doc.documentVersionId);

  const primary = await cognis.db.get<{ n: number }>(
    `SELECT MAX(is_primary) AS n FROM mention WHERE concept_id = 'wd:Q1049444'`,
  );
  const passing = await cognis.db.get<{ n: number }>(
    `SELECT MAX(is_primary) AS n FROM mention WHERE concept_id = 'wd:Q7825195'`,
  );
  assert.equal(primary?.n, 1, 'the recurring, titled concept is primary');
  assert.equal(passing?.n, 0, 'a single passing reference is not');
  await cognis.close();
});

test('unresolvable terms become local concepts, not wrong anchors', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(
    cognis, 'https://example.com/nil',
    'The Frobnicator Assembly remains unfinished. Frobnicator Assembly parts are scarce.',
    'Notes',
  );
  const report = await cognis.linkDocument(doc.documentVersionId);
  assert.ok(report.nil > 0, 'an unknown term must not be anchored to something wrong');

  const locals = await cognis.db.all<{ id: string; scheme: string }>(
    `SELECT id, scheme FROM concept WHERE scheme = 'local'`,
  );
  assert.ok(locals.length > 0);
  assert.ok(locals.every((l) => l.id.startsWith('local:')));
  await cognis.close();
});

test('relinking with a different model leaves concept ids unchanged', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/spacing', SPACING, 'Spacing');
  await cognis.linkDocument(doc.documentVersionId);

  const before = await cognis.db.all<{ concept_id: string }>(
    'SELECT DISTINCT concept_id FROM mention ORDER BY concept_id',
  );

  const { Cognis } = await import('../src/core.js');
  const { RuleLinker } = await import('../src/adapters/rule-linker.js');
  const relinked = new Cognis({
    db: cognis.db,
    clock: cognis.clock,
    embedder: cognis.embedder!,
    vocabulary: cognis.vocabulary!,
    // A different model id and prompt version: the evidence is recomputed,
    // the identity must not move. This is the bet ADR-0005 makes.
    linker: new RuleLinker({ modelId: 'rule-linker-v2', promptVersion: 'rules@2.0.0' }),
  });
  await relinked.linkAll();

  const after = await cognis.db.all<{ concept_id: string }>(
    'SELECT DISTINCT concept_id FROM mention ORDER BY concept_id',
  );
  assert.deepEqual(after, before, 'a relink must not move node identity');

  const models = await cognis.db.all<{ model_id: string }>(
    'SELECT DISTINCT model_id FROM mention',
  );
  assert.deepEqual(models.map((m) => m.model_id), ['rule-linker-v2'],
    'provenance must record the new model');
  await cognis.close();
});

test('linking is idempotent rather than accumulating duplicates', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/spacing', SPACING, 'Spacing');

  await cognis.linkDocument(doc.documentVersionId);
  const first = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mention');
  await cognis.linkDocument(doc.documentVersionId);
  const second = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mention');

  assert.equal(second!.n, first!.n);
  await cognis.close();
});

test('progress is reported before the slow work, not after it', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/spacing', SPACING,
    'Spaced repetition in practice');

  const events: { chunk: number; chunks: number; phase: string }[] = [];
  await cognis.linkDocument(doc.documentVersionId, {
    onProgress: (e) => events.push({ chunk: e.chunk, chunks: e.chunks, phase: e.phase }),
  });

  assert.ok(events.length > 0, 'linking reported nothing at all');

  // The point of the hook is that the caller hears from it BEFORE the network
  // and model calls for a chunk, not only once they have returned. A run that
  // only reports completions still looks like a hang for the first chunk.
  assert.equal(events[0]?.phase, 'candidates');
  assert.equal(events[0]?.chunk, 1);

  // Every chunk ends with exactly one `linked`, including chunks that spotted
  // nothing and made no calls — otherwise the counter stalls on a quiet chunk.
  const linked = events.filter((e) => e.phase === 'linked');
  const chunks = events[0]?.chunks ?? 0;
  assert.equal(linked.length, chunks, `expected one completion per chunk`);
  assert.deepEqual(linked.map((e) => e.chunk), [...Array(chunks).keys()].map((i) => i + 1));

  await cognis.close();
});

test('linking without a progress hook still works', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/spacing', SPACING, 'Spacing');
  const report = await cognis.linkDocument(doc.documentVersionId);
  assert.ok(report.anchored > 0);
  await cognis.close();
});

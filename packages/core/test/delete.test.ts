import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis } from './helpers.js';
import { textFingerprint } from '../src/canonical/hash.js';

async function sourceWithEverything() {
  const { cognis, clock } = await freshCognis();
  const res = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'reader',
  });
  const text = 'Interleaving beats blocking for durable retention.';
  const dv = await cognis.recordExtraction({
    sourceId: res.sourceId, ingestionEventId: res.ingestionEventId,
    text, textHash: await textFingerprint(text),
    producer: 'readability', producerVersion: '1.0.0',
  });
  await cognis.annotate(dv.documentVersionId, {
    kind: 'highlight', startChar: 0, endChar: 12, quotedText: 'Interleaving',
  });
  await cognis.db.run(
    `INSERT INTO reading_session
       (id, ingestion_event_id, started_at, ended_at, active_ms,
        max_scroll_pct, scroll_reversals, est_words_visible)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['rs000000000000000000000000', res.ingestionEventId, clock.now(), clock.now(),
     60_000, 1.0, 1, 400],
  );
  await cognis.db.run(
    `INSERT INTO user_assertion
       (id, kind, subject_type, subject_id, object_id, value, note, created_at)
     VALUES (?, 'quality', 'source', ?, NULL, 5, NULL, ?)`,
    ['ua000000000000000000000000', res.sourceId, clock.now()],
  );
  return { cognis, res };
}

test('deleting a source cascades to every dependent row', async () => {
  const { cognis, res } = await sourceWithEverything();

  const report = await cognis.deleteSource(res.sourceId);

  assert.equal(report.deletedRows['source'], 1);
  assert.equal(report.deletedRows['ingestion_event'], 1);
  assert.equal(report.deletedRows['document_version'], 1);
  assert.equal(report.deletedRows['annotation'], 1);
  assert.equal(report.deletedRows['reading_session'], 1);
  assert.equal(report.deletedRows['user_assertion'], 1);

  for (const table of [
    'source', 'ingestion_event', 'document_version', 'annotation',
    'reading_session', 'user_assertion',
  ]) {
    const row = await cognis.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    assert.equal(row?.n, 0, `${table} still has rows after deletion`);
  }
  await cognis.close();
});

test('deleting one source leaves others untouched', async () => {
  const { cognis } = await freshCognis();
  const keep = await cognis.capture({
    kind: 'url', payload: 'https://example.com/keep', capturePath: 'share_sheet',
  });
  const drop = await cognis.capture({
    kind: 'url', payload: 'https://example.com/drop', capturePath: 'share_sheet',
  });

  await cognis.deleteSource(drop.sourceId);

  assert.ok(await cognis.getSource(keep.sourceId));
  assert.equal(await cognis.getSource(drop.sourceId), null);
  await cognis.close();
});

test('deleting a source that does not exist is a no-op, not an error', async () => {
  const { cognis } = await freshCognis();
  const report = await cognis.deleteSource('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  assert.equal(report.deletedRows['source'], 0);
  await cognis.close();
});

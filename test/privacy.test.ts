/**
 * The guarantees docs/09 makes, as tests.
 *
 * These existed as prose and as a column for five milestones without anything
 * enforcing them: a source could be marked private and every pipeline would
 * send its text to a model regardless, and `egress_log` was never written to at
 * all. A documented guarantee nothing checks is worse than no guarantee, so
 * each rule now has a test that fails when it is broken.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingest } from './helpers.js';
import { classifyUrl } from '../src/privacy/domains.js';
import { redactText, redactUrl } from '../src/privacy/redact.js';
import { PrivateSourceError, withEgress } from '../src/privacy/egress.js';

const TEXT = `Spaced repetition schedules reviews at expanding intervals.
Spaced repetition strengthens the memory trace with each retrieval.`;

test('a private source is never sent for linking', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', TEXT, 'Spacing');
  await cognis.setSourcePrivate(doc.sourceId, true);

  const report = await cognis.linkDocument(doc.documentVersionId);
  assert.equal(report.skippedPrivate, true);
  assert.equal(report.mentionsWritten, 0);

  const mentions = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mention');
  assert.equal(mentions!.n, 0);

  // And nothing was logged as having left, because nothing did.
  assert.equal((await cognis.egressLog()).length, 0);
  await cognis.close();
});

test('a relink cannot pick up a private source even in bulk', async () => {
  const { cognis } = await freshCognis();
  const open = await ingest(cognis, 'https://example.com/open', TEXT, 'Open');
  const shut = await ingest(cognis, 'https://example.com/shut', TEXT, 'Shut');
  await cognis.setSourcePrivate(shut.sourceId, true);

  await cognis.linkAll();

  const fromPrivate = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mention m
       JOIN chunk c ON c.id = m.chunk_id
       JOIN document_version dv ON dv.id = c.document_version_id
      WHERE dv.source_id = ?`,
    [shut.sourceId],
  );
  assert.equal(fromPrivate!.n, 0, 'a bulk relink leaked a private source');

  const fromOpen = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mention m
       JOIN chunk c ON c.id = m.chunk_id
       JOIN document_version dv ON dv.id = c.document_version_id
      WHERE dv.source_id = ?`,
    [open.sourceId],
  );
  assert.ok(fromOpen!.n > 0, 'the non-private source should still be linked');
  await cognis.close();
});

test('private evidence is never gathered for quiz items', async () => {
  const { cognis } = await freshCognis();
  const open = await ingest(cognis, 'https://example.com/open', TEXT, 'Open');
  await cognis.linkDocument(open.documentVersionId);
  await cognis.rollupCoverage();

  const shut = await ingest(cognis, 'https://example.com/shut', TEXT, 'Shut');
  await cognis.linkDocument(shut.documentVersionId);
  await cognis.setSourcePrivate(shut.sourceId, true);
  await cognis.rollupCoverage();

  await cognis.generateItems();

  const items = await cognis.db.all<{ evidence_json: string }>(
    'SELECT evidence_json FROM quiz_item',
  );
  for (const item of items) {
    const evidence = JSON.parse(item.evidence_json) as { sourceId: string }[];
    assert.ok(
      !evidence.some((e) => e.sourceId === shut.sourceId),
      'a private source appeared in quiz evidence',
    );
  }
  await cognis.close();
});

test('the egress guard refuses outright if a private source slips through', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', TEXT, 'Spacing');
  await cognis.setSourcePrivate(doc.sourceId, true);

  // Defence in depth: even a caller that assembled the request by hand is
  // stopped at the transport boundary.
  await assert.rejects(
    withEgress(
      cognis.db, cognis.clock,
      {
        destination: 'model_proxy', purpose: 'link',
        sourceIds: [doc.sourceId], bytesSent: 100,
      },
      async () => 'sent',
    ),
    PrivateSourceError,
  );
  await cognis.close();
});

test('every model call is logged before it is made', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', TEXT, 'Spacing');

  await cognis.linkDocument(doc.documentVersionId);
  const log = await cognis.egressLog();

  assert.ok(log.length > 0, 'linking must be recorded as egress');
  for (const entry of log) {
    assert.equal(entry.destination, 'model_proxy');
    assert.equal(entry.purpose, 'link');
    assert.ok(entry.sourceIds.includes(doc.sourceId));
    assert.ok(entry.bytesSent > 0, 'the user should see how much left');
    assert.ok(entry.occurredAt);
  }
  await cognis.close();
});

test('a failed model call still appears in the log', async () => {
  const { Cognis } = await import('../src/core.js');
  const { freshCognis: fresh } = await import('./helpers.js');
  const base = await fresh();
  const doc = await ingest(base.cognis, 'https://example.com/a', TEXT, 'Spacing');

  const failing = new Cognis({
    db: base.cognis.db, clock: base.cognis.clock,
    embedder: base.cognis.embedder!, vocabulary: base.cognis.vocabulary!,
    linker: {
      modelId: 'exploding-linker', promptVersion: 'v1',
      async disambiguate() { throw new Error('proxy unavailable'); },
    },
  });

  await assert.rejects(failing.linkDocument(doc.documentVersionId), /proxy unavailable/);

  // The user's question is "what left this device", and an attempt that
  // reached the network counts even when it failed.
  const log = await base.cognis.egressLog();
  assert.ok(log.length > 0, 'a failed request must still be logged');
  await base.cognis.close();
});

test('the egress summary aggregates by destination and purpose', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingest(cognis, 'https://example.com/a', TEXT, 'Spacing');
  await cognis.linkDocument(doc.documentVersionId);
  await cognis.rollupCoverage();
  await cognis.generateItems();

  const summary = await cognis.egressSummary();
  assert.ok(summary.length > 0);
  const purposes = new Set(summary.map((s) => s.purpose));
  assert.ok(purposes.has('link'));
  for (const row of summary) {
    assert.ok(row.calls > 0);
    assert.ok(row.bytes > 0);
  }
  await cognis.close();
});

test('sensitive domains are auto-marked private at capture', async () => {
  const { cognis } = await freshCognis();

  for (const url of [
    'https://mail.google.com/mail/u/0/#inbox',
    'https://secure.chase.com/web/auth/dashboard',
    'https://mychart.com/patient/records',
    'https://intranet.acme/payroll',
    'https://shop.example.com/account/billing',
  ]) {
    const res = await cognis.capture({
      kind: 'url', payload: url, capturePath: 'share_sheet',
    });
    assert.equal(res.isPrivate, true, `${url} should be private by default`);
    assert.ok(res.privateReason, `${url} should explain why`);
  }

  const ordinary = await cognis.capture({
    kind: 'url', payload: 'https://example.com/blog/spacing', capturePath: 'share_sheet',
  });
  assert.equal(ordinary.isPrivate, false);
  await cognis.close();
});

test('the private flag ratchets one way at capture', async () => {
  const { cognis } = await freshCognis();
  const first = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'share_sheet',
    isPrivate: true,
  });
  // A later capture that does not ask for privacy must not clear it.
  const second = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'reader',
  });
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(await cognis.isSourcePrivate(first.sourceId), true);
  await cognis.close();
});

test('classification explains itself', () => {
  assert.equal(classifyUrl('https://example.com/article').isPrivate, false);
  assert.match(classifyUrl('https://localhost:3000/x').reason!, /internal/);
  assert.match(classifyUrl('https://mail.google.com/x').reason!, /sensitive service/);
  assert.match(classifyUrl('https://user:pw@example.com/x').reason!, /credentials|service/);
  assert.equal(classifyUrl('not a url').isPrivate, false, 'must not throw on junk');
});

test('redaction strips credentials and obvious secrets', () => {
  const url = redactUrl('https://example.com/x?access_token=abc123&id=7');
  assert.ok(!url.value.includes('abc123'));
  assert.ok(url.value.includes('id=7'), 'meaningful parameters survive');
  assert.ok(url.redactions.some((r) => r.kind === 'url_credential_param'));

  const text = redactText('Contact me at a@b.com with api_key: sk-livetoken123');
  assert.ok(!text.value.includes('a@b.com'));
  assert.ok(!text.value.includes('sk-livetoken123'));
  assert.ok(text.redactions.length >= 2);

  // A long run of ordinary digits is not a card number.
  const digits = redactText('The reference number is 1234567890123456789');
  assert.ok(digits.value.includes('1234567890123456789'));
});

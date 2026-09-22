import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis } from './helpers.js';
import { textFingerprint } from '../src/canonical/hash.js';

test('capture writes a source and an ingestion event', async () => {
  const { cognis } = await freshCognis();
  const res = await cognis.capture({
    kind: 'url',
    payload: 'https://example.com/a?utm_source=x',
    capturePath: 'share_sheet',
  });

  const source = await cognis.getSource(res.sourceId);
  assert.equal(source?.canonicalUrl, 'https://example.com/a');
  assert.equal(source?.kind, 'web');
  assert.equal(res.reEncounter, false);
  assert.equal(res.priorCoverage.seenBefore, false);
  await cognis.close();
});

test('re-encountering a source appends an event and does not duplicate the source', async () => {
  const { cognis, clock } = await freshCognis();
  const first = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'share_sheet',
  });

  clock.advanceDays(30);
  const second = await cognis.capture({
    kind: 'url',
    payload: 'https://www.example.com/a/?utm_campaign=newsletter',
    capturePath: 'reader',
  });

  assert.equal(second.sourceId, first.sourceId, 'must resolve to the same source');
  assert.notEqual(second.ingestionEventId, first.ingestionEventId);
  assert.equal(second.reEncounter, true);

  // Re-encounter is the signal coverage is built from, so the earlier event
  // must be visible at capture time.
  assert.equal(second.priorCoverage.seenBefore, true);
  assert.equal(second.priorCoverage.previousEvents.length, 1);

  const sources = await cognis.db.all('SELECT id FROM source');
  assert.equal(sources.length, 1);
  await cognis.close();
});

test('a DOI collapses the publisher page and the arXiv preprint into one source', async () => {
  const { cognis } = await freshCognis();
  const viaDoi = await cognis.capture({
    kind: 'doi', payload: 'https://doi.org/10.48550/arXiv.2301.04567',
    capturePath: 'share_sheet',
  });
  const viaArxiv = await cognis.capture({
    kind: 'url', payload: 'https://arxiv.org/abs/2301.04567v2',
    capturePath: 'share_sheet',
  });

  assert.equal(viaArxiv.sourceId, viaDoi.sourceId);
  const source = await cognis.getSource(viaDoi.sourceId);
  assert.equal(source?.kind, 'paper');
  await cognis.close();
});

test('a later DOI discovery upgrades an existing source instead of forking it', async () => {
  const { cognis } = await freshCognis();
  const first = await cognis.capture({
    kind: 'url', payload: 'https://arxiv.org/abs/2301.04567', capturePath: 'share_sheet',
  });
  const again = await cognis.capture({
    kind: 'doi', payload: '10.48550/arxiv.2301.04567', capturePath: 'share_sheet',
  });
  assert.equal(again.sourceId, first.sourceId);
  assert.equal((await cognis.getSource(first.sourceId))?.doi, '10.48550/arxiv.2301.04567');
  await cognis.close();
});

test('extraction failure preserves the attested record', async () => {
  const { cognis } = await freshCognis();
  const res = await cognis.capture({
    kind: 'url', payload: 'https://paywalled.example.com/x', capturePath: 'share_sheet',
  });
  await cognis.recordExtractionFailure(res.ingestionEventId, 'paywall: 402');

  const events = await cognis.recentEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.status, 'extraction_failed');
  assert.equal(events[0]!.statusReason, 'paywall: 402');
  // The user still read it; the source must survive the parser's failure.
  assert.ok(await cognis.getSource(res.sourceId));
  await cognis.close();
});

test('re-extracting identical text reuses the document version', async () => {
  const { cognis } = await freshCognis();
  const res = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'share_sheet',
  });
  const text = 'The spacing effect is robust across domains.';
  const hash = await textFingerprint(text);

  const first = await cognis.recordExtraction({
    sourceId: res.sourceId, ingestionEventId: res.ingestionEventId,
    text, textHash: hash, producer: 'readability', producerVersion: '1.0.0',
  });
  const second = await cognis.recordExtraction({
    sourceId: res.sourceId, ingestionEventId: res.ingestionEventId,
    text, textHash: hash, producer: 'readability', producerVersion: '1.0.0',
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.documentVersionId, first.documentVersionId,
    'annotations anchor to versions, so identical text must not fork one');
  await cognis.close();
});

test('engagement depth never downgrades', async () => {
  const { cognis } = await freshCognis();
  const res = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'reader',
  });

  assert.equal((await cognis.recordEngagement(res.ingestionEventId, 'read', 'telemetry')).applied, true);
  assert.equal((await cognis.recordEngagement(res.ingestionEventId, 'annotate', 'user_asserted')).applied, true);
  // A quick revisit must not erase the fact that the user annotated it.
  assert.equal((await cognis.recordEngagement(res.ingestionEventId, 'skim', 'telemetry')).applied, false);

  const events = await cognis.recentEvents();
  assert.equal(events[0]!.engagement, 'annotate');
  assert.equal(events[0]!.engagementSource, 'user_asserted');
  await cognis.close();
});

test('novelty without its embedding model is rejected by the schema', async () => {
  const { cognis } = await freshCognis();
  const res = await cognis.capture({
    kind: 'url', payload: 'https://example.com/a', capturePath: 'share_sheet',
  });
  // A novelty score is uninterpretable without the model that produced it.
  await assert.rejects(
    cognis.db.run('UPDATE ingestion_event SET novelty = 0.4 WHERE id = ?', [
      res.ingestionEventId,
    ]),
  );
  await cognis.close();
});

test('source ids are deterministic, so two devices agree without coordinating', async () => {
  const { sourceIdFor } = await import('../src/canonical/source-id.js');

  // The property sync depends on: same natural key, same id, independently.
  const a = await sourceIdFor({ canonicalUrl: 'https://example.com/a' });
  const b = await sourceIdFor({ canonicalUrl: 'https://example.com/a' });
  assert.equal(a.id, b.id);
  assert.equal(a.basis, 'url');

  // A DOI outranks a URL, being the more stable identity.
  const doi = await sourceIdFor({
    doi: '10.1234/x', canonicalUrl: 'https://example.com/a',
  });
  assert.equal(doi.basis, 'doi');
  assert.notEqual(doi.id, a.id);

  // Different material must not collide.
  const other = await sourceIdFor({ canonicalUrl: 'https://example.com/b' });
  assert.notEqual(other.id, a.id);

  // With no natural key at all, two imports are genuinely two things.
  const r1 = await sourceIdFor({});
  const r2 = await sourceIdFor({});
  assert.notEqual(r1.id, r2.id);
  assert.equal(r1.basis, 'random');
});

test('two independent captures of one URL produce one source id', async () => {
  const first = await freshCognis();
  const second = await freshCognis();

  const a = await first.cognis.capture({
    kind: 'url', payload: 'https://example.com/shared?utm_source=x',
    capturePath: 'share_sheet',
  });
  const b = await second.cognis.capture({
    kind: 'url', payload: 'https://www.example.com/shared/',
    capturePath: 'reader',
  });

  assert.equal(
    b.sourceId, a.sourceId,
    'separate devices must agree on identity without ever talking to each other',
  );
  await first.cognis.close();
  await second.cognis.close();
});

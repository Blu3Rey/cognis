import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cognis } from '../src/core.js';
import { NodeSqliteDriver } from '../src/adapters/node-sqlite.js';
import { FakeClock } from '../src/ports/clock.js';
import { HashEmbedder } from '../src/adapters/hash-embedder.js';
import { FixtureVocabulary } from '../src/adapters/fixture-vocabulary.js';
import { RuleLinker } from '../src/adapters/rule-linker.js';
import { MemoryRelay } from '../src/adapters/memory-relay.js';
import { Pbkdf2KeyDerivation, SyncCipher } from '../src/sync/crypto.js';
import { mergeRow } from '../src/sync/merge.js';
import { VOCABULARY } from './fixtures/vocabulary.js';
import { textFingerprint } from '../src/canonical/hash.js';

const PASSPHRASE = 'correct horse battery staple';

/** PBKDF2 at 600k iterations is slow by design; tests use a low cost. */
const fastKdf = new Pbkdf2KeyDerivation(1_000);

async function device(relay: MemoryRelay, start = '2026-01-01T00:00:00.000Z') {
  const clock = new FakeClock(start);
  const cognis = new Cognis({
    db: new NodeSqliteDriver(),
    clock,
    embedder: new HashEmbedder(),
    vocabulary: new FixtureVocabulary(VOCABULARY),
    linker: new RuleLinker(),
    syncRelay: relay,
    keyDerivation: fastKdf,
  });
  await cognis.migrate();
  return { cognis, clock };
}

async function pairedDevices() {
  const relay = new MemoryRelay();
  const a = await device(relay);
  const b = await device(relay, '2026-01-01T00:00:00.000Z');

  const keyset = await a.cognis.initSync();
  // The second device is enrolled with the same keyset, as it would be by
  // scanning it from the first.
  const { saveKeyset } = await import('../src/sync/sync.js');
  await saveKeyset(b.cognis.db, b.clock, keyset);

  const cipherA = await a.cognis.openCipher(PASSPHRASE);
  const cipherB = await b.cognis.openCipher(PASSPHRASE);
  return { relay, a, b, cipherA, cipherB };
}

async function capture(c: Cognis, url: string, title: string, text: string) {
  const cap = await c.capture({
    kind: 'url', payload: url, capturePath: 'share_sheet', title,
  });
  const dv = await c.recordExtraction({
    sourceId: cap.sourceId, ingestionEventId: cap.ingestionEventId,
    text, textHash: await textFingerprint(text),
    producer: 'test', producerVersion: '1.0.0',
  });
  return { ...cap, documentVersionId: dv.documentVersionId };
}

test('attested rows reach the other device', async () => {
  const { a, b, cipherA, cipherB } = await pairedDevices();
  await capture(a.cognis, 'https://example.com/a', 'Spacing',
    'Spaced repetition improves retention over time.');

  const pushed = await a.cognis.push(cipherA);
  assert.ok(pushed.pushed > 0);
  assert.ok(pushed.tables['source']! >= 1);

  const pulled = await b.cognis.pull(cipherB);
  assert.ok(pulled.applied > 0);

  const source = await b.cognis.db.get<{ canonical_url: string; title: string }>(
    'SELECT canonical_url, title FROM source',
  );
  assert.equal(source!.canonical_url, 'https://example.com/a');
  assert.equal(source!.title, 'Spacing');
  await a.cognis.close();
  await b.cognis.close();
});

test('the relay only ever holds ciphertext', async () => {
  const { relay, a, cipherA } = await pairedDevices();
  await capture(a.cognis, 'https://example.com/secret-topic', 'A revealing title',
    'Distinctive plaintext that must never appear on the relay.');
  await a.cognis.push(cipherA);

  const dump = JSON.stringify(relay.stored);
  for (const needle of [
    'secret-topic', 'A revealing title', 'Distinctive plaintext', 'example.com',
  ]) {
    assert.ok(!dump.includes(needle), `relay leaked "${needle}"`);
  }
  // What it does hold: a device id, a cursor, and an opaque envelope.
  assert.ok(relay.stored.length > 0);
  assert.equal(relay.stored[0]!.envelope.alg, 'AES-GCM');
  await a.cognis.close();
});

test('a wrong passphrase cannot open the data', async () => {
  const { a, b, cipherA } = await pairedDevices();
  await capture(a.cognis, 'https://example.com/a', 'Spacing', 'Spaced repetition.');
  await a.cognis.push(cipherA);

  const wrong = await b.cognis.openCipher('not the passphrase');
  await assert.rejects(b.cognis.pull(wrong), /wrong passphrase or tampered payload/);
  await a.cognis.close();
  await b.cognis.close();
});

test('a tampered envelope is rejected rather than decrypted to garbage', async () => {
  const { relay, a, b, cipherA, cipherB } = await pairedDevices();
  await capture(a.cognis, 'https://example.com/a', 'Spacing', 'Spaced repetition.');
  await a.cognis.push(cipherA);

  // Flip a byte of ciphertext. AES-GCM is authenticated, so this must fail.
  const batch = relay.stored[0]!;
  const ct = batch.envelope.ct;
  (batch.envelope as { ct: string }).ct =
    ct.slice(0, 4) + (ct[4] === 'A' ? 'B' : 'A') + ct.slice(5);

  await assert.rejects(b.cognis.pull(cipherB), /wrong passphrase or tampered payload/);
  await a.cognis.close();
  await b.cognis.close();
});

test('a device does not re-apply its own batches', async () => {
  const { a, cipherA } = await pairedDevices();
  await capture(a.cognis, 'https://example.com/a', 'Spacing', 'Spaced repetition.');
  await a.cognis.push(cipherA);

  const pulled = await a.cognis.pull(cipherA);
  assert.ok(pulled.skippedOwn > 0);
  assert.equal(pulled.applied, 0);
  assert.equal(pulled.merged, 0);
  await a.cognis.close();
});

test('pulling does not echo rows straight back out', async () => {
  const { a, b, cipherA, cipherB } = await pairedDevices();
  await capture(a.cognis, 'https://example.com/a', 'Spacing', 'Spaced repetition.');
  await a.cognis.push(cipherA);
  await b.cognis.pull(cipherB);

  // Without clearing the dirty flags the triggers set during a merge, the two
  // devices would push the same rows back and forth forever.
  assert.equal(
    await b.cognis.pendingSyncRows(), 0,
    'merged rows must not be queued for push again',
  );
  await a.cognis.close();
  await b.cognis.close();
});

test('two devices reading the same source converge without losing either event', async () => {
  const { a, b, cipherA, cipherB } = await pairedDevices();

  const onA = await capture(a.cognis, 'https://example.com/shared', 'Shared',
    'Spaced repetition improves retention.');
  await a.cognis.push(cipherA);
  await b.cognis.pull(cipherB);

  // Both devices now record their own reading of it.
  b.clock.advanceDays(3);
  await b.cognis.capture({
    kind: 'url', payload: 'https://example.com/shared', capturePath: 'reader',
  });
  await b.cognis.push(cipherB);
  await a.cognis.pull(cipherA);

  const eventsA = await a.cognis.db.all<{ id: string }>('SELECT id FROM ingestion_event');
  assert.equal(eventsA.length, 2, 'both readings happened; neither may overwrite the other');
  assert.ok(eventsA.some((e) => e.id === onA.ingestionEventId));

  const sources = await a.cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source');
  assert.equal(sources!.n, 1, 'one source, two events');
  await a.cognis.close();
  await b.cognis.close();
});

test('merge is commutative, so devices converge regardless of order', () => {
  const mine = {
    id: 's1', kind: 'web', canonical_url: 'https://example.com/a', doi: null,
    isbn: null, content_hash: null, title: null, authors_json: null,
    published_at: null, first_seen_at: '2026-03-01T00:00:00.000Z', is_private: 0,
  };
  const theirs = {
    id: 's1', kind: 'paper', canonical_url: null, doi: '10.1/x',
    isbn: null, content_hash: null, title: 'A paper', authors_json: null,
    published_at: null, first_seen_at: '2026-01-01T00:00:00.000Z', is_private: 1,
  };

  const ab = mergeRow('source', mine, theirs);
  const ba = mergeRow('source', theirs, mine);
  assert.deepEqual(ab, ba, 'merge order must not change the outcome');

  assert.equal(ab['doi'], '10.1/x', 'identity fills in');
  assert.equal(ab['canonical_url'], 'https://example.com/a');
  assert.equal(ab['kind'], 'paper', 'an upgrade to paper survives');
  assert.equal(ab['first_seen_at'], '2026-01-01T00:00:00.000Z', 'earliest sighting wins');
  assert.equal(ab['is_private'], 1, 'private must win, or a source becomes eligible for egress');
});

test('engagement depth never downgrades across a merge', () => {
  const shallow = {
    id: 'e1', source_id: 's1', occurred_at: '2026-01-01T00:00:00.000Z',
    capture_path: 'reader', engagement: 'skim', engagement_source: 'telemetry',
    novelty: null, novelty_model_id: null, status: 'captured', status_reason: null,
  };
  const deep = { ...shallow, engagement: 'annotate', engagement_source: 'user_asserted' };

  for (const [x, y] of [[shallow, deep], [deep, shallow]] as const) {
    const merged = mergeRow('ingestion_event', x, y);
    assert.equal(merged['engagement'], 'annotate');
    assert.equal(merged['engagement_source'], 'user_asserted');
  }
});

test('pipeline progress is not reverted by a less-advanced device', () => {
  const behind = {
    id: 'e1', source_id: 's1', occurred_at: '2026-01-01T00:00:00.000Z',
    capture_path: 'reader', engagement: null, engagement_source: null,
    novelty: null, novelty_model_id: null, status: 'captured', status_reason: null,
  };
  const ahead = { ...behind, status: 'linked' };

  assert.equal(mergeRow('ingestion_event', behind, ahead)['status'], 'linked');
  assert.equal(mergeRow('ingestion_event', ahead, behind)['status'], 'linked');
});

test('reviews sync, so retention history survives a lost device', async () => {
  const { a, b, cipherA, cipherB } = await pairedDevices();
  const doc = await capture(a.cognis, 'https://example.com/a', 'Spacing',
    'Spaced repetition improves retention over time and strengthens recall.');

  await a.cognis.db.run(
    `INSERT INTO review
       (id, quiz_item_id, item_prompt_snapshot, concept_id, presented_at,
        answered_at, answer_text, machine_grade, machine_rating, predicted_recall)
     VALUES ('r1', 'q1', 'State the core claim.', 'wd:Q1049444',
             '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:30.000Z',
             'Expanding intervals produce durable retention.', 0.8, 3, 0.85)`,
  );
  void doc;

  await a.cognis.push(cipherA);
  await b.cognis.pull(cipherB);

  const review = await b.cognis.db.get<{ answer_text: string; machine_rating: number }>(
    `SELECT answer_text, machine_rating FROM review WHERE id = 'r1'`,
  );
  assert.equal(review!.answer_text, 'Expanding intervals produce durable retention.');
  assert.equal(review!.machine_rating, 3);
  await a.cognis.close();
  await b.cognis.close();
});

test('derived data is never synced; the receiving device recomputes it', async () => {
  const { relay, a, b, cipherA, cipherB } = await pairedDevices();
  const doc = await capture(a.cognis, 'https://example.com/a', 'Spacing',
    'Spaced repetition improves retention. Spaced repetition strengthens recall.');
  await a.cognis.indexDocument({
    documentVersionId: doc.documentVersionId,
    ingestionEventId: doc.ingestionEventId,
  });

  await a.cognis.push(cipherA);
  await b.cognis.pull(cipherB);

  const dump = JSON.stringify(relay.stored);
  assert.ok(!dump.includes('chunk'), 'chunks must not travel');

  const chunks = await b.cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk');
  assert.equal(chunks!.n, 0, 'derived data arrives by recomputation, not over the wire');

  const docs = await b.cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM document_version',
  );
  assert.equal(docs!.n, 0, 'document_version is derived and stays local');
  await a.cognis.close();
  await b.cognis.close();
});

test('the recovery warning states plainly that there is no recovery', async () => {
  const { a } = await pairedDevices();
  const warning = a.cognis.recoveryWarning();

  assert.match(warning, /cannot be recovered/i);
  assert.match(warning, /we cannot read your data/i);
  // ADR-0004 requires this be stated rather than softened.
  assert.ok(!/reset your password|recover your account|support can/i.test(warning));
  await a.cognis.close();
});

test('a keyset from a different corpus is distinguished from a wrong passphrase', async () => {
  const relay = new MemoryRelay();
  const a = await device(relay);
  const b = await device(relay);

  await a.cognis.initSync();
  await b.cognis.initSync(); // a DIFFERENT keyset

  const cipherA = await a.cognis.openCipher(PASSPHRASE);
  const cipherB = await b.cognis.openCipher(PASSPHRASE);

  await capture(a.cognis, 'https://example.com/a', 'Spacing', 'Spaced repetition.');
  await a.cognis.push(cipherA);

  await assert.rejects(
    b.cognis.pull(cipherB),
    /different keyset/,
    'the remedies differ, so the errors must too',
  );
  await a.cognis.close();
  await b.cognis.close();
});

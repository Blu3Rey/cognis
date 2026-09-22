/**
 * M6 completion criterion.
 *
 * The roadmap does not state one for M6, so it is defined here as the property
 * sync exists to provide: two devices exchanging batches in any order converge
 * on the same attested set, losing nothing either of them recorded, while the
 * relay never holds anything it can read.
 *
 * Convergence is the whole claim. A sync that is merely "usually right" is a
 * sync that silently drops somebody's reading history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cognis } from '../src/core.js';
import { NodeSqliteDriver } from '../src/adapters/node-sqlite.js';
import { FakeClock } from '../src/ports/clock.js';
import { HashEmbedder } from '../src/adapters/hash-embedder.js';
import { FixtureVocabulary } from '../src/adapters/fixture-vocabulary.js';
import { RuleLinker } from '../src/adapters/rule-linker.js';
import { MemoryRelay } from '../src/adapters/memory-relay.js';
import { Pbkdf2KeyDerivation } from '../src/sync/crypto.js';
import { saveKeyset } from '../src/sync/sync.js';
import { SYNCED_TABLES } from '../src/sync/merge.js';
import { VOCABULARY } from './fixtures/vocabulary.js';
import { textFingerprint } from '../src/canonical/hash.js';

const PASSPHRASE = 'correct horse battery staple';
const fastKdf = new Pbkdf2KeyDerivation(1_000);

async function device(relay: MemoryRelay) {
  const clock = new FakeClock('2026-01-01T00:00:00.000Z');
  const cognis = new Cognis({
    db: new NodeSqliteDriver(), clock,
    embedder: new HashEmbedder(),
    vocabulary: new FixtureVocabulary(VOCABULARY),
    linker: new RuleLinker(),
    syncRelay: relay,
    keyDerivation: fastKdf,
  });
  await cognis.migrate();
  return { cognis, clock };
}

async function read(c: Cognis, url: string, title: string, text: string) {
  const cap = await c.capture({
    kind: 'url', payload: url, capturePath: 'share_sheet', title,
  });
  await c.recordExtraction({
    sourceId: cap.sourceId, ingestionEventId: cap.ingestionEventId,
    text, textHash: await textFingerprint(text),
    producer: 'test', producerVersion: '1.0.0',
  });
  return cap;
}

async function attestedSnapshot(c: Cognis): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const spec of SYNCED_TABLES) {
    out[spec.name] = await c.db.all(
      `SELECT * FROM ${spec.name} ORDER BY ${spec.key}`,
    );
  }
  return out;
}

test('two devices converge on the same attested set, losing nothing', async () => {
  const relay = new MemoryRelay();
  const a = await device(relay);
  const b = await device(relay);

  const keyset = await a.cognis.initSync();
  await saveKeyset(b.cognis.db, b.clock, keyset);
  const cipherA = await a.cognis.openCipher(PASSPHRASE);
  const cipherB = await b.cognis.openCipher(PASSPHRASE);

  // Each device reads different material, plus one source in common.
  await read(a.cognis, 'https://example.com/spacing', 'Spacing',
    'Spaced repetition improves retention over time.');
  await read(a.cognis, 'https://example.com/shared', 'Shared',
    'Retrieval practice strengthens memory.');
  await read(b.cognis, 'https://example.com/interleaving', 'Interleaving',
    'Interleaving mixes topics within a session.');
  await read(b.cognis, 'https://example.com/shared', 'Shared',
    'Retrieval practice strengthens memory.');

  // Each records judgments the other has not seen.
  const aEvents = await a.cognis.db.all<{ id: string }>(
    'SELECT id FROM ingestion_event ORDER BY id',
  );
  await a.cognis.recordEngagement(aEvents[0]!.id, 'annotate', 'user_asserted');
  await b.cognis.assert({
    kind: 'quality', subjectType: 'source',
    subjectId: (await b.cognis.db.get<{ id: string }>('SELECT id FROM source'))!.id,
    value: 5,
  });

  // Interleaved exchange, in an order neither device controls.
  await a.cognis.push(cipherA);
  await b.cognis.push(cipherB);
  await b.cognis.pull(cipherB);
  await a.cognis.pull(cipherA);
  await a.cognis.push(cipherA);
  await b.cognis.push(cipherB);
  await b.cognis.pull(cipherB);
  await a.cognis.pull(cipherA);

  const snapA = await attestedSnapshot(a.cognis);
  const snapB = await attestedSnapshot(b.cognis);

  for (const spec of SYNCED_TABLES) {
    assert.deepEqual(
      snapB[spec.name], snapA[spec.name],
      `${spec.name} did not converge`,
    );
  }

  // Nothing was lost: four reading events across three distinct sources.
  assert.equal(snapA['ingestion_event']!.length, 4);
  assert.equal(snapA['source']!.length, 3, 'the shared URL is one source on both');

  // And the judgments each device made survived the exchange.
  const annotated = await b.cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ingestion_event WHERE engagement = 'annotate'`,
  );
  assert.equal(annotated!.n, 1, 'an engagement recorded on A must reach B');
  const assertions = await a.cognis.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM user_assertion',
  );
  assert.equal(assertions!.n, 1, 'an assertion recorded on B must reach A');

  await a.cognis.close();
  await b.cognis.close();
});

test('convergence does not depend on exchange order', async () => {
  const run = async (order: 'a-first' | 'b-first') => {
    const relay = new MemoryRelay();
    const a = await device(relay);
    const b = await device(relay);
    const keyset = await a.cognis.initSync();
    await saveKeyset(b.cognis.db, b.clock, keyset);
    const cipherA = await a.cognis.openCipher(PASSPHRASE);
    const cipherB = await b.cognis.openCipher(PASSPHRASE);

    await read(a.cognis, 'https://example.com/x', 'X', 'Spaced repetition.');
    await read(b.cognis, 'https://example.com/x', 'X', 'Spaced repetition.');

    if (order === 'a-first') {
      await a.cognis.push(cipherA); await b.cognis.pull(cipherB);
      await b.cognis.push(cipherB); await a.cognis.pull(cipherA);
    } else {
      await b.cognis.push(cipherB); await a.cognis.pull(cipherA);
      await a.cognis.push(cipherA); await b.cognis.pull(cipherB);
    }

    const snap = await attestedSnapshot(a.cognis);
    const other = await attestedSnapshot(b.cognis);
    assert.deepEqual(other, snap, `devices diverged with order ${order}`);
    await a.cognis.close();
    await b.cognis.close();
    return snap;
  };

  const first = await run('a-first');
  const second = await run('b-first');

  // Ids are minted per device so they legitimately differ; what must match is
  // the shape of what survived.
  assert.equal(
    (second['ingestion_event'] as unknown[]).length,
    (first['ingestion_event'] as unknown[]).length,
  );
  assert.equal(
    (second['source'] as unknown[]).length,
    (first['source'] as unknown[]).length,
  );
});

test('a third device joining late receives the whole history', async () => {
  const relay = new MemoryRelay();
  const a = await device(relay);
  const b = await device(relay);
  const keyset = await a.cognis.initSync();
  await saveKeyset(b.cognis.db, b.clock, keyset);
  const cipherA = await a.cognis.openCipher(PASSPHRASE);
  const cipherB = await b.cognis.openCipher(PASSPHRASE);

  await read(a.cognis, 'https://example.com/one', 'One', 'Spaced repetition.');
  await a.cognis.push(cipherA);
  await b.cognis.pull(cipherB);
  await read(b.cognis, 'https://example.com/two', 'Two', 'Retrieval practice.');
  await b.cognis.push(cipherB);

  // A replacement phone, enrolled with the same keyset and an empty corpus.
  const c = await device(relay);
  await saveKeyset(c.cognis.db, c.clock, keyset);
  const cipherC = await c.cognis.openCipher(PASSPHRASE);
  const pulled = await c.cognis.pull(cipherC);

  assert.ok(pulled.applied > 0);
  const sources = await c.cognis.db.all<{ canonical_url: string }>(
    'SELECT canonical_url FROM source ORDER BY canonical_url',
  );
  assert.deepEqual(
    sources.map((s) => s.canonical_url),
    ['https://example.com/one', 'https://example.com/two'],
    'a new device must receive everything, not only what arrived after it joined',
  );
  await a.cognis.close();
  await b.cognis.close();
  await c.cognis.close();
});

test('the relay never holds readable corpus content, across a whole exchange', async () => {
  const relay = new MemoryRelay();
  const a = await device(relay);
  const b = await device(relay);
  const keyset = await a.cognis.initSync();
  await saveKeyset(b.cognis.db, b.clock, keyset);
  const cipherA = await a.cognis.openCipher(PASSPHRASE);
  const cipherB = await b.cognis.openCipher(PASSPHRASE);

  await read(a.cognis, 'https://private.example.com/diagnosis-notes',
    'Unmistakable title', 'Distinctive body text that must never leave encrypted.');
  await a.cognis.push(cipherA);
  await b.cognis.pull(cipherB);
  await b.cognis.push(cipherB);
  await a.cognis.pull(cipherA);

  const dump = JSON.stringify(relay.stored);
  for (const needle of [
    'private.example.com', 'diagnosis-notes', 'Unmistakable title',
    'Distinctive body text', 'canonical_url', 'ingestion_event',
  ]) {
    assert.ok(!dump.includes(needle), `relay leaked "${needle}"`);
  }
  await a.cognis.close();
  await b.cognis.close();
});

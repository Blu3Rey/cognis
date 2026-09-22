/**
 * The methods docs/10-api-contract.md promised and the implementation did not
 * have. Doc drift is a quiet way to ship an incomplete product: a client built
 * from the contract would have failed on four calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshCognis, ingestAndLink } from './helpers.js';
import { bucket } from '../src/coverage/timeline.js';
import { TABLES } from '../src/export/tables.js';

const TEXT = `Spaced repetition schedules reviews at expanding intervals.
Spaced repetition strengthens the memory trace with each retrieval.`;

test('the timeline shows encounters, reviews and the gaps between them', async () => {
  const { cognis, clock } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/a', TEXT, 'Spacing');

  clock.advanceDays(90);
  await ingestAndLink(cognis, 'https://example.com/b', TEXT, 'Spacing again');

  const rows = await cognis.timeline({
    from: '2025-01-01T00:00:00.000Z',
    to: '2027-01-01T00:00:00.000Z',
  });

  assert.ok(rows.length > 0, 'expected timeline rows');
  const row = rows.find((r) => r.encounters.length >= 2);
  assert.ok(row, 'a concept met twice should show both encounters');
  assert.ok(
    row!.largestGapDays >= 85,
    `the gap is the point of this view, got ${row!.largestGapDays} days`,
  );
  assert.ok(row!.firstAt && row!.lastAt);

  // Evidence only: the timeline never returns a modelled retention figure.
  assert.ok(!Object.keys(row!).some((k) => /recall|retention|score/i.test(k)));
  await cognis.close();
});

test('timeline buckets are stable', () => {
  assert.equal(bucket('2026-03-17T13:45:00.000Z', 'day'), '2026-03-17');
  assert.equal(bucket('2026-03-17T13:45:00.000Z', 'month'), '2026-03');
  // 2026-03-17 is a Tuesday; the ISO week anchors to the Monday.
  assert.equal(bucket('2026-03-17T13:45:00.000Z', 'week'), '2026-03-16');
  assert.equal(
    bucket('2026-03-16T00:00:00.000Z', 'week'),
    bucket('2026-03-22T23:59:00.000Z', 'week'),
    'a whole week falls in one bucket',
  );
});

test('deleting a concept history leaves the sources alone', async () => {
  const { cognis, clock } = await freshCognis();
  const doc = await ingestAndLink(cognis, 'https://example.com/a', TEXT, 'Spacing');
  await cognis.generateItems();

  const due = await cognis.dueItems({ limit: 1 });
  if (due.length > 0) {
    await cognis.submitReview({
      quizItemId: due[0]!.quizItemId, answerText: 'expanding intervals',
      presentedAt: clock.now(), answeredAt: clock.now(),
    });
  }

  const before = await cognis.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mention WHERE concept_id = 'wd:Q1049444'`,
  );
  assert.ok(before!.n > 0);

  const report = await cognis.deleteConceptHistory('wd:Q1049444');
  assert.ok(report.deletedRows['mention']! > 0);

  for (const [table, column] of [
    ['mention', 'concept_id'], ['review', 'concept_id'],
    ['quiz_item', 'concept_id'], ['coverage', 'concept_id'],
  ] as const) {
    const left = await cognis.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 'wd:Q1049444'`,
    );
    assert.equal(left!.n, 0, `${table} still references the deleted concept`);
  }

  // "Stop tracking this idea" is not "I never read those articles".
  assert.ok(await cognis.getSource(doc.sourceId), 'the source must survive');
  const chunks = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chunk');
  assert.ok(chunks!.n > 0, 'the extracted text must survive');
  await cognis.close();
});

test('exportAll streams every line to a sink', async () => {
  const { cognis } = await freshCognis();
  await ingestAndLink(cognis, 'https://example.com/a', TEXT, 'Spacing');

  const lines: string[] = [];
  const report = await cognis.exportAll((line) => { lines.push(line); });

  assert.equal(report.lines, lines.length);
  assert.ok(lines.length > 1, 'a header plus rows');

  const header = JSON.parse(lines[0]!) as { format: string };
  assert.equal(header.format, 'cognis-jsonl');

  // Round-trips through the sink output exactly as through the string form.
  const { cognis: restored } = await freshCognis();
  const result = await restored.importJsonlString(lines.join('\n') + '\n');
  assert.deepEqual(result.mismatches, []);
  await cognis.close();
  await restored.close();
});

test('setSourcePrivate is reversible and observable', async () => {
  const { cognis } = await freshCognis();
  const doc = await ingestAndLink(cognis, 'https://example.com/a', TEXT, 'Spacing');

  assert.equal(await cognis.isSourcePrivate(doc.sourceId), false);
  await cognis.setSourcePrivate(doc.sourceId, true);
  assert.equal(await cognis.isSourcePrivate(doc.sourceId), true);
  await cognis.setSourcePrivate(doc.sourceId, false);
  assert.equal(await cognis.isSourcePrivate(doc.sourceId), false);
  await cognis.close();
});

test('the export manifest still covers every table after the new migrations', async () => {
  const { cognis } = await freshCognis();
  const rows = await cognis.db.all<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration'`,
  );
  const known = new Set(TABLES.map((t) => t.name));
  const missing = rows.map((r) => r.name).filter((n) => !known.has(n));
  assert.deepEqual(missing, [], 'a table exists that the export does not know about');
  await cognis.close();
});

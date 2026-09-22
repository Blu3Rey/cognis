import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cognis } from '../src/core.js';
import { NodeSqliteDriver } from '../src/adapters/node-sqlite.js';
import { FakeClock } from '../src/ports/clock.js';
import { appliedMigrations, MIGRATIONS } from '../src/db/migrate.js';

test('migrations apply once and are idempotent across restarts', async () => {
  const cognis = new Cognis({
    db: new NodeSqliteDriver(),
    clock: new FakeClock('2026-01-01T00:00:00.000Z'),
  });

  const expected = MIGRATIONS.map((m) => m.id);
  const first = await cognis.migrate();
  assert.deepEqual(first.applied, expected);

  // A device that opens the app twice must not re-run migrations.
  const second = await cognis.migrate();
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.alreadyApplied, expected);

  assert.deepEqual(await appliedMigrations(cognis.db), [...expected].sort());
  await cognis.close();
});

test('foreign keys are enforced', async () => {
  const cognis = new Cognis({
    db: new NodeSqliteDriver(),
    clock: new FakeClock('2026-01-01T00:00:00.000Z'),
  });
  await cognis.migrate();
  // Cascading deletion is load-bearing for docs/09 deletion guarantees, so a
  // dangling reference must be rejected rather than quietly accepted.
  await assert.rejects(
    cognis.db.run(
      `INSERT INTO ingestion_event
         (id, source_id, occurred_at, capture_path, status)
       VALUES ('x', 'nonexistent', '2026-01-01T00:00:00Z', 'share_sheet', 'captured')`,
    ),
  );
  await cognis.close();
});

test('a failed transaction rolls back completely', async () => {
  const cognis = new Cognis({
    db: new NodeSqliteDriver(),
    clock: new FakeClock('2026-01-01T00:00:00.000Z'),
  });
  await cognis.migrate();

  await assert.rejects(
    cognis.db.transaction(async () => {
      await cognis.db.run(
        `INSERT INTO source (id, kind, first_seen_at) VALUES ('s1', 'web', '2026-01-01T00:00:00Z')`,
      );
      throw new Error('boom');
    }),
    /boom/,
  );

  const row = await cognis.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source');
  assert.equal(row?.n, 0, 'rollback must leave nothing behind');
  await cognis.close();
});

/**
 * Guards the failure mode where a migration adds a table and the export
 * quietly stops being complete. Run in CI; a test covers it too, but this
 * fails loudly and on its own line.
 */
import {
  Cognis, NodeSqliteDriver, FakeClock, assertManifestCoversSchema,
} from '../dist/src/index.js';

const cognis = new Cognis({
  db: new NodeSqliteDriver(),
  clock: new FakeClock('2026-01-01T00:00:00.000Z'),
});

try {
  await cognis.migrate();
  await assertManifestCoversSchema(cognis.db);
  console.log('export manifest covers the schema');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await cognis.close();
}
